// src/components/trivia/triviaGameManager.js
import logger from '../../lib/logger.js';
import { enqueueMessage } from '../../lib/ircSender.js';
import { getContextManager } from '../context/contextManager.js';
import { translateText } from '../../lib/translationUtils.js';
import { generateQuestion, verifyAnswer, calculateStringSimilarity } from './triviaQuestionService.js';
import {
    formatStartMessage, formatQuestionMessage, formatCorrectAnswerMessage,
    formatTimeoutMessage, formatStopMessage, formatGameSessionScoresMessage
} from './triviaMessageFormatter.js';
import {
    loadChannelConfig, saveChannelConfig, recordGameResult,
    updatePlayerScore, getRecentQuestions, getRecentAnswers, getLeaderboard, clearChannelLeaderboardData, getLatestCompletedSessionInfo as getLatestTriviaSession, reportProblemQuestion as flagTriviaQuestionProblem, flagTriviaQuestionByDocId
} from './triviaStorage.js';
import crypto from 'crypto';

// --- Default Configuration ---
const DEFAULT_CONFIG = {
    difficulty: 'normal',
    questionTimeSeconds: 45,
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
const RECENT_QUESTION_FETCH_LIMIT = 50; // How many recent questions to fetch for exclusion

// --- In-Memory Storage for Active Games ---
/** @type {Map<string, GameState>} */
const activeGames = new Map(); // channelName -> GameState

const pendingTriviaReports = new Map();
const PENDING_TRIVIA_REPORT_TIMEOUT_MS = 60000;

// --- Question Deduplication Helpers ---
function _tokenizeForSignature(text) {
    if (!text || typeof text !== 'string') return [];
    const lower = text.toLowerCase();
    const cleaned = lower.replace(/[^a-z0-9\s]/g, ' ');
    const rawTokens = cleaned.split(/\s+/).filter(Boolean);
    const STOPWORDS = new Set([
        'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'where', 'why', 'how', 'what', 'which', 'who', 'whom', 'whose', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'of', 'to', 'in', 'for', 'on', 'by', 'with', 'about', 'into', 'over', 'after', 'before', 'between', 'during', 'from', 'as', 'at', 'that', 'this', 'these', 'those', 'do', 'does', 'did', 'done', 'has', 'have', 'had', 'having', 'many', 'much', 'number', 'count'
    ]);
    const tokens = rawTokens
        .map(t => t.trim())
        .filter(t => t.length > 1 && !STOPWORDS.has(t));
    // Simple stemming for plurals
    return tokens.map(t => (t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

function _buildQuestionSignature(text) {
    const tokens = _tokenizeForSignature(text);
    const uniqueSorted = Array.from(new Set(tokens)).sort();
    return uniqueSorted.join('|');
}

/**
 * Checks whether a newly generated answer is too similar to any previously excluded answer.
 * Catches exact matches, containment ("Wilbur" in "Orville and Wilbur"), and
 * high Levenshtein similarity (> 0.75).
 * @param {string} newAnswer - The candidate answer to check.
 * @param {string[]} excludedAnswers - Array of lowercased answers to avoid.
 * @returns {boolean} true if the answer should be rejected.
 */
function _isAnswerTooSimilar(newAnswer, excludedAnswers) {
    if (!newAnswer || !excludedAnswers || excludedAnswers.length === 0) return false;
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const newNorm = norm(newAnswer);
    if (!newNorm) return false;

    for (const excluded of excludedAnswers) {
        const exNorm = norm(excluded);
        if (!exNorm) continue;

        // 1. Exact match
        if (newNorm === exNorm) return true;

        // 2. Containment: one answer is a substring of the other
        //    e.g. "wilbur" contained in "orville and wilbur"
        if (newNorm.length >= 3 && exNorm.length >= 3) {
            if (newNorm.includes(exNorm) || exNorm.includes(newNorm)) {
                return true;
            }
        }

        // 3. High string similarity (Levenshtein)
        const similarity = calculateStringSimilarity(newNorm, exNorm);
        if (similarity > 0.75) return true;
    }

    return false;
}

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
    gameSessionExcludedAnswers: Set<string>,
    streakMap: Map<string, number>,
    gameSessionId: string | null
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
            gameSessionId: null,
            totalRounds: 1,
            currentRound: 1,
            gameSessionScores: new Map(),
            gameSessionExcludedQuestions: new Set(),
            gameSessionExcludedAnswers: new Set(),
            streakMap: new Map(),
            guessCache: new Map(), // Cache for incorrect guesses this round
            questionSignatureSet: new Set() // Track normalized signatures to avoid paraphrased duplicates
        });
    } else {
        // Ensure new fields exist on potentially older state objects
        const state = activeGames.get(channelName);
        if (!state.gameSessionExcludedQuestions) {
            state.gameSessionExcludedQuestions = new Set();
        }
        if (!state.gameSessionExcludedAnswers) {
            state.gameSessionExcludedAnswers = new Set();
        }
        if (!state.streakMap) {
            state.streakMap = new Map();
        }
        if (!state.guessCache) {
            state.guessCache = new Map();
        }
        if (!state.questionSignatureSet) {
            state.questionSignatureSet = new Set();
        }
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
    newState.gameSessionExcludedAnswers = new Set();
    newState.streakMap = new Map();
    newState.guessCache = new Map();
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

    gameState.state = 'ending';
    logger.info(`[TriviaGame][${gameState.channelName}] Round ${gameState.currentRound}/${gameState.totalRounds} ending. Reason: ${reason}`);

    const isMultiRound = gameState.totalRounds > 1;
    const isLastRound = gameState.currentRound === gameState.totalRounds;

    // --- Add current question to session exclusion set (if valid) ---
    if (gameState.currentQuestion?.question) {
        gameState.gameSessionExcludedQuestions.add(gameState.currentQuestion.question);
        // NEW: Add current answer and alternates to session excluded answers
        if (gameState.currentQuestion.answer) {
            gameState.gameSessionExcludedAnswers.add(gameState.currentQuestion.answer.toLowerCase());
            if (gameState.currentQuestion.alternateAnswers && gameState.currentQuestion.alternateAnswers.length > 0) {
                gameState.currentQuestion.alternateAnswers.forEach(alt => gameState.gameSessionExcludedAnswers.add(alt.toLowerCase()));
            }
        }
        logger.debug(`[TriviaGame][${gameState.channelName}] Excluded Qs: ${gameState.gameSessionExcludedQuestions.size}, Excluded As: ${gameState.gameSessionExcludedAnswers.size}`);
    }
    // --- End answer exclusion update ---

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
                difficulty: gameState.currentQuestion.difficulty,
                pointsAwarded: points,
                searchUsed: gameState.currentQuestion.searchUsed || false,
                verified: typeof gameState.currentQuestion.verified === 'boolean' ? gameState.currentQuestion.verified : undefined,
                gameSessionId: gameState.gameSessionId,
                roundNumber: gameState.currentRound,
                totalRounds: gameState.totalRounds,
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
    } else if (isMultiRound && !isLastRound && reason !== "stopped" && reason !== "question_error" && reason !== "timer_error") {
        // Proceed to next round
        logger.info(`[TriviaGame][${gameState.channelName}] Proceeding to round ${gameState.currentRound + 1}.`);
        gameState.currentRound++;

        // Reset round-specific state
        gameState.currentQuestion = null;
        gameState.startTime = null;
        gameState.answers = [];
        gameState.winner = null;
        gameState.guessCache.clear(); // Clear guess cache for next round

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

    // 1. Generate Question
    let questionGenerated = false;
    let retries = 0;
    let recentChannelQuestions = [];
    let recentChannelAnswers = [];
    // Fetch recent questions (globally for the channel, beyond the current session)
    try {
        recentChannelQuestions = await getRecentQuestions(gameState.channelName, gameState.topic, RECENT_QUESTION_FETCH_LIMIT); // Fetch last N questions
        try {
            recentChannelAnswers = await getRecentAnswers(gameState.channelName, gameState.topic, RECENT_QUESTION_FETCH_LIMIT);
        } catch (error) {
            logger.error({ err: error }, `[TriviaGame][${gameState.channelName}] Error fetching recent channel answers for exclusion.`);
        }
        logger.debug(`[TriviaGame][${gameState.channelName}] Retrieved ${recentChannelQuestions.length} recent channel questions to potentially exclude.`);
    } catch (error) {
        logger.error({ err: error }, `[TriviaGame][${gameState.channelName}] Error fetching recent channel questions for exclusion.`);
    }
    // Combine session exclusions with recent channel exclusions
    const combinedExcludedQuestions = new Set([...gameState.gameSessionExcludedQuestions, ...recentChannelQuestions]);
    const finalExcludedQuestionsArray = Array.from(combinedExcludedQuestions);
    const finalExcludedAnswersArray = Array.from(new Set([...gameState.gameSessionExcludedAnswers, ...recentChannelAnswers]));
    // Also avoid having the topic itself as the answer (tautology)
    if (gameState.topic && typeof gameState.topic === 'string') {
        const t = gameState.topic.trim();
        if (t.length > 0) {
            finalExcludedAnswersArray.push(t);
            finalExcludedAnswersArray.push(t.toLowerCase());
        }
    }

    while (!questionGenerated && retries < MAX_QUESTION_RETRIES) {
        try {
            // --- Pass excluded questions and answers to generateQuestion ---
            const question = await generateQuestion(
                gameState.topic,
                gameState.config.difficulty,
                finalExcludedQuestionsArray, // Pass the combined list
                gameState.channelName,
                finalExcludedAnswersArray // Pass excluded answers
            );
            // --- End modification ---
            if (
                question &&
                question.question &&
                typeof question.question === 'string' &&
                question.question.trim().length >= 10 &&
                question.answer &&
                String(question.answer).trim().length > 0
            ) {
                // Double-check if the generated question is somehow still excluded
                const qSig = _buildQuestionSignature(question.question);
                if (combinedExcludedQuestions.has(question.question) || gameState.questionSignatureSet.has(qSig)) {
                    logger.warn(`[TriviaGame][${gameState.channelName}] LLM generated an excluded question (attempt ${retries + 1}). Retrying.`);
                    retries++;
                    await new Promise(resolve => setTimeout(resolve, 500));
                } else if (_isAnswerTooSimilar(question.answer, finalExcludedAnswersArray)) {
                    logger.warn(`[TriviaGame][${gameState.channelName}] LLM generated a question with a repeat answer "${question.answer}" (attempt ${retries + 1}). Retrying.`);
                    retries++;
                    await new Promise(resolve => setTimeout(resolve, 500));
                } else {
                    gameState.currentQuestion = question;
                    // No need to add to exclusion set here, it's added in _transitionToEnding
                    questionGenerated = true;
                    logger.info(`[TriviaGame][${gameState.channelName}] Question generated for round ${gameState.currentRound}.`);
                    gameState.questionSignatureSet.add(qSig);
                }
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

    // Final guard: if somehow invalid slipped through, end this round gracefully
    if (!gameState.currentQuestion?.question ||
        typeof gameState.currentQuestion.question !== 'string' ||
        gameState.currentQuestion.question.trim().length < 10 ||
        !gameState.currentQuestion?.answer ||
        String(gameState.currentQuestion.answer).trim().length === 0) {
        logger.error(`[TriviaGame][${gameState.channelName}] Generated question failed final validation: ${JSON.stringify(gameState.currentQuestion)}`);
        enqueueMessage(`#${gameState.channelName}`, `⚠️ Error: Generated question was invalid. Ending the game.`);
        await _transitionToEnding(gameState, "question_error");
        return;
    }

    // 2. Start Round
    gameState.startTime = Date.now();
    gameState.state = 'inProgress';
    gameState.guessCache.clear(); // Clear cache for the new round

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
        logger.debug(`[TriviaGame][${channelName}] _handleAnswer early return: gameState=${!!gameState}, state=${gameState?.state}, hasQuestion=${!!gameState?.currentQuestion}, message="${message}"`);
        return;
    }

    const now = Date.now();
    if (now - gameState.lastMessageTimestamp < 500) {
        logger.debug(`[TriviaGame][${channelName}] Rate limit: ignoring answer from ${username} (${now - gameState.lastMessageTimestamp}ms since last)`);
        return;
    }
    gameState.lastMessageTimestamp = now;

    const userAnswer = message.trim();
    if (!userAnswer) return;

    // Check the cache for this normalized answer first
    const normalizedUserAnswer = userAnswer.toLowerCase().trim();
    if (gameState.guessCache.has(normalizedUserAnswer)) {
        logger.debug(`[TriviaGame][${channelName}] Answer "${userAnswer}" found in incorrect guess cache. Skipping LLM verification.`);
        return; // It's a known wrong answer for this round, do nothing.
    }

    logger.debug(`[TriviaGame][${channelName}] Processing answer: "${userAnswer}" from ${username}`);
    gameState.answers.push({ username, displayName, answer: userAnswer, timestamp: new Date() });

    // Added: Translate user's answer if botlang is set
    const contextManager = getContextManager();
    const botLanguage = contextManager.getBotLanguage(channelName);
    let answerToVerify = userAnswer;

    if (botLanguage && botLanguage.toLowerCase() !== 'english' && botLanguage.toLowerCase() !== 'en') {
        logger.debug(`[TriviaGame][${channelName}] Bot language is ${botLanguage}. Translating user answer "${userAnswer}" to English for verification.`);
        try {
            const translatedUserAnswer = await translateText(userAnswer, 'English');
            if (translatedUserAnswer && translatedUserAnswer.trim().length > 0) {
                answerToVerify = translatedUserAnswer.trim();
                logger.info(`[TriviaGame][${channelName}] Translated user answer for verification: "${userAnswer}" -> "${answerToVerify}"`);
            } else {
                logger.warn(`[TriviaGame][${channelName}] Translation of answer "${userAnswer}" to English resulted in empty string. Using original for verification.`);
            }
        } catch (translateError) {
            logger.error({ err: translateError, channelName, userAnswer, botLanguage }, `[TriviaGame][${channelName}] Failed to translate user answer to English for verification. Using original.`);
        }
    }
    // End of added translation logic

    try {
        const verificationResult = await verifyAnswer(
            gameState.currentQuestion.answer,
            answerToVerify, // Use the potentially translated answer
            gameState.currentQuestion.alternateAnswers || [],
            gameState.currentQuestion.question,
            gameState.topic || 'general'
        );

        if (gameState.state !== 'inProgress') {
            logger.debug(`[TriviaGame][${channelName}] Game state changed to ${gameState.state} while verifying answer.`);
            return;
        }

        if (verificationResult && verificationResult.is_correct) {
            logger.info(`[TriviaGame][${channelName}] Correct answer "${userAnswer}" (verified as "${answerToVerify}") by ${username}. Confidence: ${verificationResult.confidence || 'N/A'}`);
            gameState.winner = { username, displayName };
            gameState.state = 'guessed';
            const timeTakenMs = Date.now() - gameState.startTime;
            _transitionToEnding(gameState, "guessed", timeTakenMs);
        } else {
            // Cache the incorrect answer to prevent re-verification
            gameState.guessCache.set(normalizedUserAnswer, {
                result: verificationResult,
                timestamp: Date.now()
            });
            logger.debug(`[TriviaGame][${channelName}] Caching incorrect guess: "${userAnswer}"`);
        }
    } catch (error) {
        logger.error({ err: error }, `[TriviaGame][${channelName}] Error validating answer "${userAnswer}" (verified as "${answerToVerify}") from ${username}.`);
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

    // Initialize game state (ensure new fields are reset)
    gameState.gameSessionId = crypto.randomUUID();
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
    gameState.gameSessionExcludedAnswers = new Set();
    gameState.streakMap = new Map();
    gameState.guessCache = new Map();
    _clearTimers(gameState);

    logger.info(`[TriviaGame][${channelName}] Starting new game. Topic: ${topic || 'General'}, Rounds: ${gameState.totalRounds}, Initiator: ${gameState.initiatorUsername}`);

    // Only send preamble if user specified rounds > 1 or a specific topic
    if (gameState.totalRounds > 1 || topic !== null) {
        const startMessage = formatStartMessage(
            topic || 'General Knowledge',
            gameState.config.questionTimeSeconds,
            gameState.totalRounds
        );

        enqueueMessage(`#${channelName}`, startMessage);
    }

    try {
        // Generate first question
        let retries = 0;
        let questionGenerated = false;
        let recentChannelQuestions = [];
        let recentChannelAnswers = [];
        // Fetch recent questions for the first round
        try {
            recentChannelQuestions = await getRecentQuestions(channelName, topic, RECENT_QUESTION_FETCH_LIMIT); // Fetch last N
            try {
                recentChannelAnswers = await getRecentAnswers(channelName, topic, RECENT_QUESTION_FETCH_LIMIT);
            } catch (error) {
                logger.error({ err: error }, `[TriviaGame][${channelName}] Error fetching recent answers for Round 1 exclusion.`);
            }
            gameState.gameSessionExcludedQuestions = new Set(recentChannelQuestions); // Initialize session set
            logger.debug(`[TriviaGame][${channelName}] Retrieved ${recentChannelQuestions.length} recent questions to exclude for Round 1.`);
        } catch (error) {
            logger.error({ err: error }, `[TriviaGame][${channelName}] Error fetching recent questions for Round 1 exclusion.`);
            // Continue with empty exclusion list if fetching fails
            gameState.gameSessionExcludedQuestions = new Set();
        }
        const finalExcludedQuestionsArray = Array.from(gameState.gameSessionExcludedQuestions);
        const finalExcludedAnswersArray = Array.from(new Set([...gameState.gameSessionExcludedAnswers, ...recentChannelAnswers]));
        // Also avoid having the topic itself as the answer (tautology)
        if (topic && typeof topic === 'string') {
            const t = topic.trim();
            if (t.length > 0) {
                finalExcludedAnswersArray.push(t);
                finalExcludedAnswersArray.push(t.toLowerCase());
            }
        }
        while (!questionGenerated && retries < MAX_QUESTION_RETRIES) {
            try {
                // --- Pass excluded questions and answers to generateQuestion ---
                const question = await generateQuestion(
                    topic,
                    gameState.config.difficulty,
                    finalExcludedQuestionsArray, // Pass current exclusion set
                    channelName,
                    finalExcludedAnswersArray // Pass excluded answers
                );
                // --- End modification ---
                if (
                    question &&
                    question.question &&
                    typeof question.question === 'string' &&
                    question.question.trim().length >= 10 &&
                    question.answer &&
                    String(question.answer).trim().length > 0
                ) {
                    // Double-check if the generated question is somehow still excluded
                    const qSig = _buildQuestionSignature(question.question);
                    if (finalExcludedQuestionsArray.includes(question.question) || gameState.questionSignatureSet.has(qSig)) {
                        logger.warn(`[TriviaGame][${channelName}] LLM generated an excluded question for Round 1 (attempt ${retries + 1}). Retrying.`);
                        retries++;
                        await new Promise(resolve => setTimeout(resolve, 500));
                    } else if (_isAnswerTooSimilar(question.answer, finalExcludedAnswersArray)) {
                        logger.warn(`[TriviaGame][${channelName}] LLM generated a question with a repeat answer "${question.answer}" for Round 1 (attempt ${retries + 1}). Retrying.`);
                        retries++;
                        await new Promise(resolve => setTimeout(resolve, 500));
                    } else {
                        gameState.currentQuestion = question;
                        // Don't add to exclusion set here, done in _transitionToEnding
                        questionGenerated = true;
                        logger.info(`[TriviaGame][${channelName}] First question generated successfully.`);
                        gameState.questionSignatureSet.add(qSig);
                    }
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

        // Final guard: if somehow invalid slipped through, end gracefully
        if (!gameState.currentQuestion?.question ||
            typeof gameState.currentQuestion.question !== 'string' ||
            gameState.currentQuestion.question.trim().length < 10 ||
            !gameState.currentQuestion?.answer ||
            String(gameState.currentQuestion.answer).trim().length === 0) {
            logger.error(`[TriviaGame][${channelName}] Generated first question failed final validation: ${JSON.stringify(gameState.currentQuestion)}`);
            throw new Error("Generated first question was invalid.");
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
 * Initiates the process for reporting a problematic Trivia question.
 * If the last game was multi-round, it prompts the user for a round number.
 * Otherwise, it reports the last played question directly.
 * @param {string} channelName - Channel name (without #).
 * @param {string} reason - Reason for reporting.
 * @param {string} reportedByUsername - Username of the reporter (lowercase).
 * @returns {Promise<{success: boolean, message: string, needsFollowUp?: boolean}>}
 */
async function initiateReportProcess(channelName, reason, reportedByUsername) {
    logger.info(`[TriviaGameManager][${channelName}] Initiating report process. Reason: "${reason}", By: ${reportedByUsername}`);
    const sessionInfo = await getLatestTriviaSession(channelName);

    if (!sessionInfo || !sessionInfo.itemsInSession || sessionInfo.itemsInSession.length === 0) {
        logger.warn(`[TriviaGameManager][${channelName}] No session info found for reporting.`);
        return { success: false, message: "I couldn't find a recently played Trivia round in this channel to report." };
    }

    const { totalRounds, itemsInSession } = sessionInfo;
    const reportedByDisplayName = reportedByUsername;

    if (totalRounds > 1 && itemsInSession.length > 0) {
        const reportKey = `${channelName}_${reportedByUsername.toLowerCase()}`;
        // Ensure these are set BEFORE pendingTriviaReports.set
        global.debug_lastSetTriviaPendingMap = pendingTriviaReports;
        global.debug_lastSetTriviaReportKey = reportKey;
        logger.debug({ key: global.debug_lastSetTriviaReportKey }, "[TriviaGameManager] Set global.debug_lastSetTriviaReportKey");
        logger.debug({
            channel: channelName,
            user: reportedByUsername,
            reportKey: reportKey,
            reason: reason,
            itemsInSession: itemsInSession
        }, `[TriviaGameManager] Storing pending trivia report.`);
        pendingTriviaReports.set(reportKey, {
            reason,
            itemsInSession,
            reportedByUsername,
            expiresAt: Date.now() + PENDING_TRIVIA_REPORT_TIMEOUT_MS
        });
        logger.debug({
            reportKeyStored: reportKey,
            pendingTriviaReportsSizeAfterSet: pendingTriviaReports.size,
            allPendingKeysAfterSet: Array.from(pendingTriviaReports.keys())
        }, `[TriviaGameManager] initiateReport: Data set in pendingTriviaReports.`);
        setTimeout(() => {
            if (pendingTriviaReports.has(reportKey) && pendingTriviaReports.get(reportKey).expiresAt <= Date.now()) {
                pendingTriviaReports.delete(reportKey);
                logger.info(`[TriviaGameManager][${channelName}] Expired pending trivia report for ${reportKey}`);
            }
        }, PENDING_TRIVIA_REPORT_TIMEOUT_MS + 1000);
        const maxRoundFound = itemsInSession.reduce((max, item) => Math.max(max, item.roundNumber), 0);
        let promptMessage = `@${reportedByDisplayName}, the last Trivia game had ${totalRounds} round(s).`;
        if (itemsInSession.length < totalRounds && itemsInSession.length > 0) {
            promptMessage = `@${reportedByDisplayName}, I found ${itemsInSession.length} question(s) from the last session (expected ${totalRounds}).`;
        }
        promptMessage += ` Which round's question (1-${maxRoundFound}) are you reporting? Reply with just the number.`;
        return { success: true, message: promptMessage, needsFollowUp: true };
    } else if (itemsInSession.length === 1) {
        const itemToReport = itemsInSession[0];
        if (!itemToReport || !itemToReport.itemData || !itemToReport.itemData.question) {
            logger.warn(`[TriviaGameManager][${channelName}] Single item session, but question data missing for report.`);
            return { success: false, message: "Could not identify a specific question to report from the last game." };
        }
        try {
            await flagTriviaQuestionProblem(itemToReport.itemData.question, reason, reportedByUsername);
            logger.info(`[TriviaGameManager][${channelName}] Successfully reported single/latest question: "${itemToReport.itemData.question.substring(0, 50)}..."`);
            return { success: true, message: `Thanks for the feedback! The question ("${itemToReport.itemData.question.substring(0, 30)}...") has been reported.` };
        } catch (error) {
            logger.error({ err: error, channelName }, `[TriviaGameManager][${channelName}] Error reporting question directly.`);
            return { success: false, message: "Sorry, an error occurred while trying to report the question." };
        }
    } else {
        logger.warn(`[TriviaGameManager][${channelName}] No items found in session for reporting, though sessionInfo was present.`);
        return { success: false, message: "No specific questions found in the last game session to report." };
    }
}

/**
 * Finalizes a report for a Trivia question based on the user-provided round number.
 * @param {string} channelName - Channel name (without #).
 * @param {string} username - Username of the user responding (lowercase).
 * @param {string} roundNumberStr - The numeric string provided by the user.
 * @returns {Promise<{success: boolean, message: string | null}>}
 */
async function finalizeReportWithRoundNumber(channelName, username, roundNumberStr) {
    const reportKey = `${channelName}_${username.toLowerCase()}`;
    // --- VERY FOCUSED DEBUG LOG ---
    logger.debug({
        location: "TriviaManager.finalizeReport - Start",
        reportKeyToLookup: reportKey,
        currentMapSize: pendingTriviaReports.size,
        mapHasThisKey: pendingTriviaReports.has(reportKey),
        currentMapKeys: Array.from(pendingTriviaReports.keys())
    }, `[TriviaGameManager] finalizeReport: Map state just before .get()`);
    // --- END FOCUSED DEBUG LOG ---
    const pendingData = pendingTriviaReports.get(reportKey);
    if (!pendingData) {
        logger.warn({
            location: "TriviaManager.finalizeReport - No Pending Data",
            keyLookedUp: reportKey,
            mapHadKeyResult: pendingTriviaReports.has(reportKey)
        }, `[TriviaGameManager] finalizeReport: No pendingData found for key.`);
        return { success: false, message: null };
    }

    if (pendingData.expiresAt <= Date.now()) {
        pendingTriviaReports.delete(reportKey);
        logger.info(`[TriviaGameManager][${channelName}] Attempt to finalize an expired trivia report by ${username}.`);
        return { success: true, message: `@${username}, your report session timed out. Please use !trivia report again.` };
    }

    const roundNum = parseInt(roundNumberStr, 10);
    const itemToReport = pendingData.itemsInSession.find(item => item.roundNumber === roundNum);

    if (isNaN(roundNum) || !itemToReport) {
        const maxRound = pendingData.itemsInSession.reduce((max, item) => Math.max(max, item.roundNumber), 0);
        return { success: true, message: `@${username}, that's not a valid round number (1-${maxRound}) from the last game session. Please reply with a valid number or try reporting again.` };
    }

    if (!itemToReport.docId || !itemToReport.itemData || !itemToReport.itemData.question) {
        pendingTriviaReports.delete(reportKey);
        logger.error(`[TriviaGameManager][${channelName}] Found item for round ${roundNum} but it's missing docId or question data.`);
        return { success: true, message: `@${username}, I found round ${roundNum}, but there was an issue identifying the question for the report. Please try again.` };
    }

    try {
        await flagTriviaQuestionByDocId(itemToReport.docId, pendingData.reason, pendingData.reportedByUsername);
        pendingTriviaReports.delete(reportKey);
        logger.info(`[TriviaGameManager][${channelName}] Successfully finalized report for trivia round ${roundNum}, doc ID ${itemToReport.docId}, Question: "${itemToReport.itemData.question.substring(0, 30)}..."`);
        return { success: true, message: `@${username}, thanks! Your report for the question from round ${roundNum} ("${itemToReport.itemData.question.substring(0, 30)}...") has been submitted.` };
    } catch (error) {
        logger.error({ err: error, channelName }, `[TriviaGameManager][${channelName}] Error finalizing report for trivia round ${roundNum}.`);
        return { success: true, message: `@${username}, an error occurred submitting your report for round ${roundNum}. Please try again or contact a mod.` };
    }
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
        clearLeaderboard,
        initiateReportProcess,
        finalizeReportWithRoundNumber
    };
}

export { initializeTriviaGameManager, getTriviaGameManager, activeGames, _isAnswerTooSimilar };