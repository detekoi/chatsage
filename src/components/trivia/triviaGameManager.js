// src/components/trivia/triviaGameManager.js
import logger from '../../lib/logger.js';
import { enqueueMessage } from '../../lib/ircSender.js';
import { generateQuestion, verifyAnswer, generateExplanation } from './triviaQuestionService.js';
import { formatStartMessage, formatQuestionMessage, formatCorrectAnswerMessage, 
         formatTimeoutMessage, formatStopMessage, formatGameSessionScoresMessage } from './triviaMessageFormatter.js';
import { loadChannelConfig, saveChannelConfig, recordGameResult, 
         updatePlayerScore, getRecentQuestions, getLeaderboard, clearChannelLeaderboardData } from './triviaStorage.js';

// --- Default Configuration ---
const DEFAULT_CONFIG = {
    difficulty: 'normal',
    questionTimeSeconds: 30,
    roundDurationMinutes: 2,
    scoreTracking: true,
    topicPreferences: [],
    pointsBase: 10, // Base points for a correct answer
    pointsTimeBonus: true, // Whether to give bonus points for fast answers
    pointsDifficultyMultiplier: true // Whether to multiply points by difficulty
};

const MAX_IRC_MESSAGE_LENGTH = 450; // Should match ircSender.js
const MULTI_ROUND_DELAY_MS = 5000; // Delay between rounds
const MAX_QUESTION_RETRIES = 3; // Maximum number of retries for question generation

// --- In-Memory Storage for Active Games ---
/** @type {Map<string, GameState>} */
const activeGames = new Map(); // channelName -> GameState

/*
GameState structure:
{
    channelName: string,
    topic: string | null,
    state: 'idle' | 'selecting' | 'started' | 'inProgress' | 'guessed' | 'timeout' | 'ending',
    currentQuestion: {
        question: string,
        answer: string,
        alternateAnswers: string[],
        explanation: string,
        difficulty: string,
        topic: string
    } | null,
    startTime: number | null,
    questionEndTimer: NodeJS.Timeout | null,
    answers: Array<{username: string, displayName: string, answer: string, timestamp: Date}>,
    winner: {username: string, displayName: string} | null,
    initiatorUsername: string | null,
    config: Object,
    lastMessageTimestamp: number,
    
    // Multi-round fields
    totalRounds: number,
    currentRound: number,
    gameSessionScores: Map<string, {displayName: string, score: number}>,
    gameSessionExcludedQuestions: Set<string>,
    streakMap: Map<string, number> // username -> consecutive correct answers
}
*/

// --- Helper Functions ---
/**
 * Gets or creates a game state for a channel.
 * @param {string} channelName - Channel name without #.
 * @returns {Promise<Object>} Game state object.
 */
async function _getOrCreateGameState(channelName) {
    if (!activeGames.has(channelName)) {
        logger.debug(`[TriviaGame] Creating new game state for channel: ${channelName}`);
        let loadedConfig = null;
        try {
            loadedConfig = await loadChannelConfig(channelName);
        } catch (error) {
            logger.error({ err: error, channel: channelName }, "[TriviaGame] Failed to load channel config from storage, using defaults.");
        }
        if (!loadedConfig) {
            logger.info(`[TriviaGame][${channelName}] No saved config found, using default.`);
            loadedConfig = { ...DEFAULT_CONFIG };
            try {
                await saveChannelConfig(channelName, loadedConfig);
            } catch (error) {
                logger.error({ err: error, channel: channelName }, "[TriviaGame] Failed to save default config to storage.");
            }
        } else {
            logger.info(`[TriviaGame][${channelName}] Loaded saved config.`);
            loadedConfig = { ...DEFAULT_CONFIG, ...loadedConfig };
        }
        
        activeGames.set(channelName, {
            channelName,
            topic: null,
            state: 'idle',
            currentQuestion: null,
            startTime: null,
            questionEndTimer: null,
            answers: [],
            winner: null,
            initiatorUsername: null,
            config: loadedConfig,
            lastMessageTimestamp: 0,
            
            // Multi-round fields
            totalRounds: 1,
            currentRound: 1,
            gameSessionScores: new Map(),
            gameSessionExcludedQuestions: new Set(),
            streakMap: new Map()
        });
    }
    return activeGames.get(channelName);
}

/**
 * Clears any active timers for a game state.
 * @param {Object} gameState - Game state object.
 */
function _clearTimers(gameState) {
    if (gameState.questionEndTimer) {
        clearTimeout(gameState.questionEndTimer);
        gameState.questionEndTimer = null;
    }
}

/**
 * Fully resets a game state to idle.
 * @param {Object} gameState - Game state object.
 */
async function _resetGameToIdle(gameState) {
    logger.info(`[TriviaGame][${gameState.channelName}] Resetting game state fully to idle.`);
    _clearTimers(gameState);
    
    const config = gameState.config; // Preserve config
    // Get a fresh structure
    const newState = await _getOrCreateGameState(gameState.channelName);
    newState.config = config; // Restore config
    newState.state = 'idle';
    
    // Explicitly clear game-specific data
    newState.topic = null;
    newState.currentQuestion = null;
    newState.startTime = null;
    newState.answers = [];
    newState.winner = null;
    newState.initiatorUsername = null;
    
    // Reset multi-round fields
    newState.totalRounds = 1;
    newState.currentRound = 1;
    newState.gameSessionScores = new Map();
    newState.gameSessionExcludedQuestions = new Set();
    newState.streakMap = new Map();
}

/**
 * Calculates points for a correct answer based on game config.
 * @param {Object} gameState - Game state object.
 * @param {number} timeElapsedMs - Time elapsed in milliseconds.
 * @returns {number} Points earned.
 */
function _calculatePoints(gameState, timeElapsedMs) {
    let points = gameState.config.pointsBase;
    
    // Apply difficulty multiplier if enabled
    if (gameState.config.pointsDifficultyMultiplier && gameState.currentQuestion?.difficulty) {
        switch (gameState.currentQuestion.difficulty.toLowerCase()) {
            case 'easy':
                points *= 1;
                break;
            case 'normal':
                points *= 1.5;
                break;
            case 'hard':
                points *= 2;
                break;
        }
    }
    
    // Apply time bonus if enabled
    if (gameState.config.pointsTimeBonus) {
        const totalTimeMs = gameState.config.questionTimeSeconds * 1000;
        const timeRemainingRatio = Math.max(0, (totalTimeMs - timeElapsedMs) / totalTimeMs);
        const timeBonus = Math.floor(points * 0.5 * timeRemainingRatio); // Up to 50% bonus for speed
        points += timeBonus;
    }
    
    // Apply streak bonus if applicable
    const username = gameState.winner?.username;
    if (username) {
        const currentStreak = gameState.streakMap.get(username) || 0;
        if (currentStreak > 1) {
            // Apply a streak multiplier (10% per consecutive answer after the first)
            const streakMultiplier = 1 + ((currentStreak - 1) * 0.1);
            points = Math.floor(points * streakMultiplier);
        }
    }
    
    return Math.floor(points);
}

/**
 * Transitions a game to the ending state.
 * @param {Object} gameState - Game state object.
 * @param {string} reason - Reason for ending ('guessed', 'timeout', 'stopped', etc.).
 * @param {number} [timeTakenMs] - Time taken to answer in milliseconds.
 * @returns {Promise<void>}
 */
async function _transitionToEnding(gameState, reason = "guessed", timeTakenMs = null) {
    _clearTimers(gameState);
    
    // If already ending/idle, do nothing further
    if (gameState.state === 'ending' || gameState.state === 'idle') {
        logger.warn(`[TriviaGame][${gameState.channelName}] Game state is already '${gameState.state}'. Ignoring transition request.`);
        return;
    }
    
    const previousState = gameState.state;
    gameState.state = 'ending';
    logger.info(`[TriviaGame][${gameState.channelName}] Round ${gameState.currentRound}/${gameState.totalRounds} ending. Reason: ${reason}`);
    
    const isMultiRound = gameState.totalRounds > 1;
    const isLastRound = gameState.currentRound === gameState.totalRounds;
    
    // --- 1. Handle Scoring ---
    let points = 0;
    if (reason === "guessed" && gameState.winner?.username) {
        const winnerUsername = gameState.winner.username;
        const winnerDisplayName = gameState.winner.displayName;
        
        // Calculate points
        points = _calculatePoints(gameState, timeTakenMs || 0);
        
        // Update streak for the winner
        const currentStreak = gameState.streakMap.get(winnerUsername) || 0;
        gameState.streakMap.set(winnerUsername, currentStreak + 1);
        
        // a) Update session score
        if (isMultiRound) {
            const currentSessionScore = gameState.gameSessionScores.get(winnerUsername)?.score || 0;
            gameState.gameSessionScores.set(winnerUsername, {
                displayName: winnerDisplayName,
                score: currentSessionScore + points
            });
            logger.debug(`[TriviaGame][${gameState.channelName}] Updated session score for ${winnerUsername}: ${currentSessionScore + points}`);
        }
        
        // b) Update persistent score
        if (gameState.config.scoreTracking) {
            try {
                await updatePlayerScore(winnerUsername, gameState.channelName, points, winnerDisplayName);
                logger.debug(`[TriviaGame][${gameState.channelName}] Successfully updated score for ${winnerUsername}.`);
            } catch (scoreError) {
                logger.error({ err: scoreError }, `[TriviaGame][${gameState.channelName}] Error updating score for ${winnerUsername}.`);
            }
        }
    } else {
        // Reset all streaks on timeout/stop
        gameState.streakMap.clear();
    }
    
    // --- 2. Send End Round Message ---
    let endMessage = "";
    if (!gameState.currentQuestion?.question) {
        logger.error(`[TriviaGame][${gameState.channelName}] Cannot generate round end message: question is missing.`);
        endMessage = "An error occurred, and the round information couldn't be displayed.";
    } else {
        try {
            const roundPrefix = isMultiRound ? `(Round ${gameState.currentRound}/${gameState.totalRounds}) ` : "";
            
            if (reason === "guessed" && gameState.winner) {
                const seconds = typeof timeTakenMs === 'number' ? Math.round(timeTakenMs / 1000) : null;
                const timeString = seconds !== null ? ` in ${seconds}s` : '';
                const streakInfo = gameState.streakMap.get(gameState.winner.username) > 1 ? 
                    ` 🔥x${gameState.streakMap.get(gameState.winner.username)}` : '';
                const pointsInfo = points > 0 ? ` (+${points} pts)` : '';
                
                endMessage = formatCorrectAnswerMessage(
                    roundPrefix,
                    gameState.winner.displayName,
                    gameState.currentQuestion.answer,
                    gameState.currentQuestion.explanation,
                    timeString,
                    streakInfo,
                    pointsInfo
                );
            } else if (reason === "timeout") {
                endMessage = formatTimeoutMessage(
                    roundPrefix,
                    gameState.currentQuestion.answer,
                    gameState.currentQuestion.explanation
                );
            } else if (reason === "stopped") {
                endMessage = formatStopMessage(
                    roundPrefix,
                    gameState.currentQuestion.answer
                );
            } else {
                endMessage = `${roundPrefix}The answer was: ${gameState.currentQuestion.answer}`;
            }
            
            // Ensure message doesn't exceed max length
            if (endMessage.length > MAX_IRC_MESSAGE_LENGTH) {
                endMessage = endMessage.substring(0, MAX_IRC_MESSAGE_LENGTH - 3) + "...";
            }
        } catch (error) {
            logger.error({ err: error }, `[TriviaGame][${gameState.channelName}] Error formatting round end message.`);
            endMessage = `${reason === "guessed" ? `@${gameState.winner.displayName} got it right!` : ''} The answer was: ${gameState.currentQuestion?.answer || "N/A"}`;
        }
    }
    
    enqueueMessage(`#${gameState.channelName}`, endMessage);
    
    // --- 3. Record Game Result ---
    if (gameState.config.scoreTracking && gameState.currentQuestion?.question) {
        try {
            const gameDetails = {
                channel: gameState.channelName,
                topic: gameState.topic || "general",
                question: gameState.currentQuestion.question,
                answer: gameState.currentQuestion.answer,
                winner: gameState.winner?.username || null,
                winnerDisplay: gameState.winner?.displayName || null,
                startTime: gameState.startTime ? new Date(gameState.startTime).toISOString() : null,
                endTime: new Date().toISOString(),
                durationMs: gameState.startTime ? (Date.now() - gameState.startTime) : null,
                reasonEnded: reason,
                roundNumber: gameState.currentRound,
                totalRounds: gameState.totalRounds,
                difficulty: gameState.currentQuestion.difficulty,
                pointsAwarded: points
            };
            
            await recordGameResult(gameDetails);
            logger.debug(`[TriviaGame][${gameState.channelName}] Successfully recorded game result.`);
        } catch (storageError) {
            logger.error({ err: storageError }, `[TriviaGame][${gameState.channelName}] Error recording game result.`);
        }
    }
    
    // --- 4. Determine Next Step ---
    if (reason === "stopped") {
        // Game manually stopped - end completely
        logger.info(`[TriviaGame][${gameState.channelName}] Game session ended by stop command.`);
        
        if (isMultiRound && gameState.gameSessionScores.size > 0) {
            // Report final scores if multi-round
            const sessionScoresMessage = formatGameSessionScoresMessage(gameState.gameSessionScores);
            enqueueMessage(`#${gameState.channelName}`, `🏁 Game stopped. Final Scores: ${sessionScoresMessage}`);
        }
        
        // Reset after delay
        setTimeout(() => _resetGameToIdle(gameState), MULTI_ROUND_DELAY_MS);
    } else if (isMultiRound && !isLastRound) {
        // Proceed to next round
        logger.info(`[TriviaGame][${gameState.channelName}] Proceeding to round ${gameState.currentRound + 1}.`);
        gameState.currentRound++;
        
        // Reset round-specific state
        gameState.currentQuestion = null;
        gameState.startTime = null;
        gameState.answers = [];
        gameState.winner = null;
        
        // Start next round after delay
        setTimeout(() => _startNextRound(gameState), MULTI_ROUND_DELAY_MS);
    } else {
        // Game complete (last round or single round)
        logger.info(`[TriviaGame][${gameState.channelName}] Game session finished.`);
        
        if (isMultiRound && gameState.gameSessionScores.size > 0) {
            // Report final session scores
            const sessionScoresMessage = formatGameSessionScoresMessage(gameState.gameSessionScores);
            enqueueMessage(`#${gameState.channelName}`, `🏁 Final Scores: ${sessionScoresMessage}`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Show overall leaderboard
        if (gameState.config.scoreTracking) {
            try {
                const leaderboardData = await getLeaderboard(gameState.channelName, 5);
                if (leaderboardData && leaderboardData.length > 0) {
                    let leaderboardMessage = `🏆 Trivia Champions: `;
                    const topPlayers = leaderboardData
                        .sort((a, b) => (b.data?.channelPoints || 0) - (a.data?.channelPoints || 0))
                        .slice(0, 5);
                    
                    leaderboardMessage += topPlayers
                        .map((p, i) => `${i + 1}. ${p.data?.displayName || p.id} (${p.data?.channelPoints || 0} pts)`)
                        .join(', ');
                    
                    enqueueMessage(`#${gameState.channelName}`, leaderboardMessage);
                }
            } catch (error) {
                logger.error({ err: error }, `[TriviaGame][${gameState.channelName}] Error fetching leaderboard.`);
            }
        }
        
        // Reset after delay
        setTimeout(() => _resetGameToIdle(gameState), MULTI_ROUND_DELAY_MS);
    }
}

/**
 * Starts the next round in a multi-round game.
 * @param {Object} gameState - Game state object.
 * @returns {Promise<void>}
 */
async function _startNextRound(gameState) {
    logger.info(`[TriviaGame][${gameState.channelName}] Starting round ${gameState.currentRound}/${gameState.totalRounds}`);
    gameState.state = 'selecting';
    
    // Announce next round
    const roundMessage = `🎮 Starting Round ${gameState.currentRound}/${gameState.totalRounds}...`;
    enqueueMessage(`#${gameState.channelName}`, roundMessage);
    
    // 1. Generate Question
    let questionGenerated = false;
    let retries = 0;
    let excludedQuestionsArray = Array.from(gameState.gameSessionExcludedQuestions);
    
    while (!questionGenerated && retries < MAX_QUESTION_RETRIES) {
        try {
            const question = await generateQuestion(
                gameState.topic,
                gameState.config.difficulty,
                excludedQuestionsArray,
                gameState.channelName
            );
            
            if (question && question.question && question.answer) {
                gameState.currentQuestion = question;
                gameState.gameSessionExcludedQuestions.add(question.question);
                questionGenerated = true;
                logger.info(`[TriviaGame][${gameState.channelName}] Question generated for round ${gameState.currentRound}.`);
            } else {
                logger.warn(`[TriviaGame][${gameState.channelName}] Failed to generate valid question (attempt ${retries + 1}).`);
                retries++;
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        } catch (error) {
            logger.error({ err: error }, `[TriviaGame][${gameState.channelName}] Error generating question (attempt ${retries + 1}).`);
            retries++;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    
    if (!questionGenerated) {
        logger.error(`[TriviaGame][${gameState.channelName}] Failed to generate question after ${MAX_QUESTION_RETRIES} attempts.`);
        enqueueMessage(`#${gameState.channelName}`, `⚠️ Error: Could not generate a question for round ${gameState.currentRound}. Ending the game.`);
        await _transitionToEnding(gameState, "question_error");
        return;
    }
    
    // 2. Start Round
    gameState.startTime = Date.now();
    gameState.state = 'inProgress';
    
    // 3. Send Question
    const questionMessage = formatQuestionMessage(
        gameState.currentRound,
        gameState.totalRounds,
        gameState.currentQuestion.question,
        gameState.currentQuestion.difficulty,
        gameState.config.questionTimeSeconds
    );
    
    enqueueMessage(`#${gameState.channelName}`, questionMessage);
    
    // 4. Set Question Timer
    const timeoutMs = gameState.config.questionTimeSeconds * 1000;
    
    gameState.questionEndTimer = setTimeout(async () => {
        try {
            if (gameState.state === 'inProgress') {
                logger.info(`[TriviaGame][${gameState.channelName}] Round ${gameState.currentRound} timed out.`);
                gameState.state = 'timeout';
                await _transitionToEnding(gameState, "timeout");
            }
        } catch (error) {
            logger.error({ err: error }, `[TriviaGame][${gameState.channelName}] Error in question timeout handler.`);
            if (gameState.state !== 'ending' && gameState.state !== 'idle') {
                await _transitionToEnding(gameState, "timer_error");
            }
        }
    }, timeoutMs);
    
    logger.info(`[TriviaGame][${gameState.channelName}] Round ${gameState.currentRound} started with ${timeoutMs}ms timer.`);
}

/**
 * Processes a potential answer from a user.
 * @param {string} channelName - Channel name without #.
 * @param {string} username - User's lowercase username.
 * @param {string} displayName - User's display name.
 * @param {string} message - The chat message (potential answer).
 * @returns {Promise<void>}
 */
async function _handleAnswer(channelName, username, displayName, message) {
    const gameState = activeGames.get(channelName);
    
    if (!gameState || gameState.state !== 'inProgress' || !gameState.currentQuestion) {
        return;
    }
    
    // Basic throttling
    const now = Date.now();
    if (now - gameState.lastMessageTimestamp < 500) {
        return;
    }
    gameState.lastMessageTimestamp = now;
    
    const userAnswer = message.trim();
    if (!userAnswer) return;
    
    logger.debug(`[TriviaGame][${channelName}] Processing answer: "${userAnswer}" from ${username}`);
    
    // Store answer
    gameState.answers.push({
        username,
        displayName,
        answer: userAnswer,
        timestamp: new Date()
    });
    
    try {
        // Verify against the current question
        const verificationResult = await verifyAnswer(
            gameState.currentQuestion.answer,
            userAnswer,
            gameState.currentQuestion.alternateAnswers || [],
            gameState.currentQuestion.question
        );
        
        // Check state again after verification
        if (gameState.state !== 'inProgress') {
            logger.debug(`[TriviaGame][${channelName}] Game state changed to ${gameState.state} while verifying answer.`);
            return;
        }
        
        if (verificationResult && verificationResult.is_correct) {
            logger.info(`[TriviaGame][${channelName}] Correct answer "${userAnswer}" by ${username}. Confidence: ${verificationResult.confidence || 'N/A'}`);
            
            // Set winner
            gameState.winner = { username, displayName };
            gameState.state = 'guessed';
            
            // Calculate time taken
            const timeTakenMs = Date.now() - gameState.startTime;
            
            // Transition to ending
            _transitionToEnding(gameState, "guessed", timeTakenMs);
        }
    } catch (error) {
        logger.error({ err: error }, `[TriviaGame][${channelName}] Error validating answer "${userAnswer}" from ${username}.`);
    }
}

// --- Game Start/Stop Functions ---

/**
 * Starts a new game session.
 * @param {string} channelName - Channel name without #.
 * @param {string} topic - Topic for questions (null for general).
 * @param {string} initiatorUsername - Username of the user who started the game.
 * @param {number} numberOfRounds - Number of rounds (default 1).
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
async function startGame(channelName, topic = null, initiatorUsername = null, numberOfRounds = 1) {
    const gameState = await _getOrCreateGameState(channelName);
    
    if (gameState.state !== 'idle') {
        logger.warn(`[TriviaGame][${channelName}] Attempted to start game while state is ${gameState.state}`);
        
        if (gameState.initiatorUsername === initiatorUsername?.toLowerCase() && gameState.totalRounds > 1) {
            return {
                success: false,
                error: `A ${gameState.totalRounds}-round game initiated by you is already in progress (round ${gameState.currentRound}). Use !trivia stop if needed.`
            };
        }
        
        return {
            success: false,
            error: `A game is already active (${gameState.state}). Please wait or use !trivia stop.`
        };
    }
    
    // Initialize game state
    gameState.initiatorUsername = initiatorUsername?.toLowerCase() || null;
    gameState.topic = topic;
    gameState.state = 'selecting';
    gameState.currentQuestion = null;
    gameState.startTime = null;
    gameState.answers = [];
    gameState.winner = null;
    gameState.totalRounds = Math.max(1, numberOfRounds);
    gameState.currentRound = 1;
    gameState.gameSessionScores = new Map();
    gameState.gameSessionExcludedQuestions = new Set();
    gameState.streakMap = new Map();
    
    _clearTimers(gameState);
    
    logger.info(`[TriviaGame][${channelName}] Starting new game. Topic: ${topic || 'General'}, Rounds: ${gameState.totalRounds}, Initiator: ${gameState.initiatorUsername}`);
    
    // Send start message
    const startMessage = formatStartMessage(
        topic || 'General Knowledge',
        gameState.config.questionTimeSeconds,
        gameState.totalRounds
    );
    
    enqueueMessage(`#${channelName}`, startMessage);
    
    try {
        // Generate first question
        let retries = 0;
        let questionGenerated = false;
        let recentQuestions = [];
        
        try {
            recentQuestions = await getRecentQuestions(channelName, topic, 30);
            logger.debug(`[TriviaGame][${channelName}] Retrieved ${recentQuestions.length} recent questions to exclude.`);
        } catch (error) {
            logger.error({ err: error }, `[TriviaGame][${channelName}] Error fetching recent questions.`);
        }
        
        while (!questionGenerated && retries < MAX_QUESTION_RETRIES) {
            try {
                const question = await generateQuestion(
                    topic,
                    gameState.config.difficulty,
                    recentQuestions,
                    channelName
                );
                
                if (question && question.question && question.answer) {
                    gameState.currentQuestion = question;
                    gameState.gameSessionExcludedQuestions.add(question.question);
                    questionGenerated = true;
                    logger.info(`[TriviaGame][${channelName}] First question generated successfully.`);
                } else {
                    logger.warn(`[TriviaGame][${channelName}] Failed to generate valid first question (attempt ${retries + 1}).`);
                    retries++;
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            } catch (error) {
                logger.error({ err: error }, `[TriviaGame][${channelName}] Error generating first question (attempt ${retries + 1}).`);
                retries++;
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
        
        if (!questionGenerated) {
            throw new Error(`Failed to generate a valid question after ${MAX_QUESTION_RETRIES} attempts.`);
        }
        
        // Starting the round
        gameState.startTime = Date.now();
        gameState.state = 'inProgress';
        
        // Send question
        const questionMessage = formatQuestionMessage(
            1,
            gameState.totalRounds,
            gameState.currentQuestion.question,
            gameState.currentQuestion.difficulty,
            gameState.config.questionTimeSeconds
        );
        
        enqueueMessage(`#${channelName}`, questionMessage);
        
        // Set question timer
        const timeoutMs = gameState.config.questionTimeSeconds * 1000;
        
        gameState.questionEndTimer = setTimeout(async () => {
            try {
                if (gameState.state === 'inProgress') {
                    logger.info(`[TriviaGame][${channelName}] Round ${gameState.currentRound} timed out.`);
                    gameState.state = 'timeout';
                    await _transitionToEnding(gameState, "timeout");
                }
            } catch (error) {
                logger.error({ err: error }, `[TriviaGame][${channelName}] Error in question timeout handler.`);
                if (gameState.state !== 'ending' && gameState.state !== 'idle') {
                    await _transitionToEnding(gameState, "timer_error");
                }
            }
        }, timeoutMs);
        
        logger.info(`[TriviaGame][${channelName}] Game started successfully. Round 1/${gameState.totalRounds}.`);
        return { success: true };
        
    } catch (error) {
        logger.error({ err: error }, `[TriviaGame][${channelName}] Critical error starting game.`);
        await _resetGameToIdle(gameState);
        
        return {
            success: false,
            error: `Error starting game: ${error.message || 'Unknown error'}`
        };
    }
}

/**
 * Stops an active game.
 * @param {string} channelName - Channel name without #.
 * @returns {{message: string}} Result message.
 */
function stopGame(channelName) {
    const gameState = activeGames.get(channelName);
    
    if (!gameState || gameState.state === 'idle' || gameState.state === 'ending') {
        logger.debug(`[TriviaGame][${channelName}] Stop command received, but no active game found.`);
        return { message: "No active Trivia game to stop." };
    }
    
    logger.info(`[TriviaGame][${channelName}] Stop command received during round ${gameState.currentRound}/${gameState.totalRounds}.`);
    
    // Transition to ending with "stopped" reason
    _transitionToEnding(gameState, "stopped");
    
    return { message: "Trivia game stopped successfully." };
}

/**
 * Processes a potential answer from chat.
 * @param {string} channelName - Channel name without #.
 * @param {string} username - User's lowercase username.
 * @param {string} displayName - User's display name.
 * @param {string} message - Chat message text.
 */
function processPotentialAnswer(channelName, username, displayName, message) {
    const gameState = activeGames.get(channelName);
    
    if (gameState && gameState.state === 'inProgress' && !message.startsWith('!')) {
        _handleAnswer(channelName, username, displayName, message).catch(err => {
            logger.error({ err, channel: channelName, user: username }, `[TriviaGame][${channelName}] Unhandled error processing answer.`);
        });
    }
}

/**
 * Configures game settings.
 * @param {string} channelName - Channel name without #.
 * @param {object} options - Configuration options.
 * @returns {Promise<{message: string}>} Result message.
 */
async function configureGame(channelName, options) {
    const gameState = await _getOrCreateGameState(channelName);
    logger.info(`[TriviaGame][${channelName}] Configure command received with options: ${JSON.stringify(options)}`);
    
    let changesMade = [];
    let configChanged = false;
    
    // Update difficulty
    if (options.difficulty && ['easy', 'normal', 'hard'].includes(options.difficulty)) {
        if (gameState.config.difficulty !== options.difficulty) {
            gameState.config.difficulty = options.difficulty;
            changesMade.push(`Difficulty set to ${options.difficulty}`);
            configChanged = true;
        }
    }
    
    // Update question time
    if (options.questionTimeSeconds) {
        const time = parseInt(options.questionTimeSeconds, 10);
        if (!isNaN(time) && time >= 10 && time <= 120) {
            if (gameState.config.questionTimeSeconds !== time) {
                gameState.config.questionTimeSeconds = time;
                changesMade.push(`Question time set to ${time} seconds`);
                configChanged = true;
            }
        } else {
            changesMade.push(`Invalid question time "${options.questionTimeSeconds}". Must be between 10 and 120 seconds.`);
        }
    }
    
    // Update round duration
    if (options.roundDurationMinutes) {
        const duration = parseInt(options.roundDurationMinutes, 10);
        if (!isNaN(duration) && duration >= 1 && duration <= 10) {
            if (gameState.config.roundDurationMinutes !== duration) {
                gameState.config.roundDurationMinutes = duration;
                changesMade.push(`Round duration set to ${duration} minutes`);
                configChanged = true;
            }
        } else {
            changesMade.push(`Invalid round duration "${options.roundDurationMinutes}". Must be between 1 and 10 minutes.`);
        }
    }
    
    // Toggle score tracking
    if (options.scoreTracking !== undefined) {
        const enableScoring = options.scoreTracking === 'true' || options.scoreTracking === true;
        if (gameState.config.scoreTracking !== enableScoring) {
            gameState.config.scoreTracking = enableScoring;
            changesMade.push(`Score tracking ${enableScoring ? 'enabled' : 'disabled'}`);
            configChanged = true;
        }
    }
    
    // Update topic preferences
    if (options.topicPreferences) {
        const topics = Array.isArray(options.topicPreferences) ? 
            options.topicPreferences : 
            String(options.topicPreferences).split(',').map(s => s.trim()).filter(Boolean);
        
        gameState.config.topicPreferences = topics;
        changesMade.push(`Topic preferences updated to: ${topics.join(', ') || 'None'}`);
        configChanged = true;
    }
    
    // Update points base
    if (options.pointsBase) {
        const points = parseInt(options.pointsBase, 10);
        if (!isNaN(points) && points > 0 && points <= 100) {
            if (gameState.config.pointsBase !== points) {
                gameState.config.pointsBase = points;
                changesMade.push(`Base points set to ${points}`);
                configChanged = true;
            }
        } else {
            changesMade.push(`Invalid base points "${options.pointsBase}". Must be between 1 and 100.`);
        }
    }
    
    // Toggle time bonus
    if (options.pointsTimeBonus !== undefined) {
        const enableTimeBonus = options.pointsTimeBonus === 'true' || options.pointsTimeBonus === true;
        if (gameState.config.pointsTimeBonus !== enableTimeBonus) {
            gameState.config.pointsTimeBonus = enableTimeBonus;
            changesMade.push(`Time bonus ${enableTimeBonus ? 'enabled' : 'disabled'}`);
            configChanged = true;
        }
    }
    
    // Toggle difficulty multiplier
    if (options.pointsDifficultyMultiplier !== undefined) {
        const enableMultiplier = options.pointsDifficultyMultiplier === 'true' || options.pointsDifficultyMultiplier === true;
        if (gameState.config.pointsDifficultyMultiplier !== enableMultiplier) {
            gameState.config.pointsDifficultyMultiplier = enableMultiplier;
            changesMade.push(`Difficulty multiplier ${enableMultiplier ? 'enabled' : 'disabled'}`);
            configChanged = true;
        }
    }
    
    if (configChanged) {
        try {
            await saveChannelConfig(channelName, gameState.config);
            logger.info(`[TriviaGame][${channelName}] Configuration updated and saved: ${changesMade.join(', ')}`);
            return { message: `Trivia settings updated: ${changesMade.join('. ')}.` };
        } catch (error) {
            logger.error({ err: error }, `[TriviaGame][${channelName}] Failed to save configuration changes.`);
            return { message: `Settings updated in memory, but failed to save them permanently.` };
        }
    } else if (changesMade.length > 0 && !configChanged) {
        return { message: `Trivia settings not changed: ${changesMade.join('. ')}.` };
    } else {
        return { message: "No valid configuration options provided. Use !trivia help config for options." };
    }
}

/**
 * Resets channel configuration to defaults.
 * @param {string} channelName - Channel name without #.
 * @returns {Promise<{success: boolean, message: string}>} Result.
 */
async function resetChannelConfig(channelName) {
    const gameState = await _getOrCreateGameState(channelName);
    logger.info(`[TriviaGame][${channelName}] Resetting configuration to defaults.`);
    
    try {
        const newConfig = { ...DEFAULT_CONFIG };
        gameState.config = newConfig;
        await saveChannelConfig(channelName, gameState.config);
        logger.info(`[TriviaGame][${channelName}] Configuration successfully reset and saved.`);
        return { success: true, message: "Trivia configuration reset to defaults." };
    } catch (error) {
        logger.error({ err: error }, `[TriviaGame][${channelName}] Failed to save reset configuration.`);
        return { success: false, message: "Configuration reset in memory, but failed to save permanently." };
    }
}

/**
 * Gets the username of the current game initiator.
 * @param {string} channelName - Channel name without #.
 * @returns {string|null} Initiator username or null.
 */
function getCurrentGameInitiator(channelName) {
    const gameState = activeGames.get(channelName);
    if (gameState && gameState.state !== 'idle') {
        return gameState.initiatorUsername;
    }
    return null;
}

/**
 * Clears the leaderboard for a channel.
 * @param {string} channelName - Channel name without #.
 * @returns {Promise<{success: boolean, message: string}>} Result.
 */
async function clearLeaderboard(channelName) {
    logger.info(`[TriviaGame][${channelName}] Received request to clear leaderboard data.`);
    
    try {
        const result = await clearChannelLeaderboardData(channelName.toLowerCase());
        logger.info(`[TriviaGame][${channelName}] Leaderboard clear result: ${result.message}`);
        return { success: result.success, message: result.message };
    } catch (error) {
        logger.error({ err: error }, `[TriviaGame][${channelName}] Error clearing leaderboard data.`);
        return { success: false, message: `An error occurred: ${error.message || 'Unknown error'}` };
    }
}

/**
 * Initializes the trivia game manager.
 */
async function initializeTriviaGameManager() {
    logger.info("Initializing Trivia Game Manager...");
    activeGames.clear();
    logger.info("Trivia Game Manager initialized successfully.");
}

/**
 * Gets the trivia game manager instance.
 * @returns {Object} The manager interface.
 */
function getTriviaGameManager() {
    // Expose public methods
    return {
        initialize: initializeTriviaGameManager,
        startGame,
        stopGame,
        processPotentialAnswer,
        configureGame,
        resetChannelConfig,
        getCurrentGameInitiator,
        clearLeaderboard
    };
}

export { initializeTriviaGameManager, getTriviaGameManager };