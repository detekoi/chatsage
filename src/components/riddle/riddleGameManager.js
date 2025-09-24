// src/components/riddle/riddleGameManager.js
import logger from '../../lib/logger.js';
import { enqueueMessage } from '../../lib/ircSender.js';
import { getContextManager } from '../context/contextManager.js';
import { translateText } from '../../lib/translationUtils.js';
import { generateRiddle, verifyRiddleAnswer } from './riddleService.js';
import {
    formatRiddleStartMessage,
    formatRiddleQuestionMessage,
    formatRiddleCorrectAnswerMessage,
    formatRiddleTimeoutMessage,
    formatRiddleStopMessage,
    formatRiddleSessionScoresMessage,
    formatRiddleLeaderboardMessage
} from './riddleMessageFormatter.js';
import {
    loadChannelRiddleConfig,
    saveChannelRiddleConfig,
    recordRiddleResult,
    updatePlayerScore,
    getRecentKeywords,
    saveRiddleKeywords, // To save keywords of successfully answered riddles
    getLeaderboard,
    clearLeaderboardData as clearRiddleLeaderboardData,
    getMostRecentRiddlePlayed,
    flagRiddleAsProblem,
    getLatestCompletedSessionInfo,
    saveRecentAnswer,
    getRecentAnswers
} from './riddleStorage.js';
import crypto from 'crypto';

// --- Default Configuration ---
const DEFAULT_RIDDLE_CONFIG = {
    difficulty: 'normal',       // 'easy', 'normal', 'hard'
    questionTimeSeconds: 45,    // Time to answer a riddle
    pointsBase: 15,
    pointsTimeBonus: true,
    pointsDifficultyMultiplier: true,
    scoreTracking: true,
    maxRounds: 10,
    recentKeywordsFetchLimit: 50, // How many recent keyword sets to fetch for exclusion
    multiRoundDelayMs: 5000,      // Delay between rounds
    maxRiddleGenerationRetries: 3
};

// --- In-Memory Storage for Active Games ---
/** @type {Map<string, GameState>} */
const activeGames = new Map();

const pendingReports = new Map(); // Key: "channelName_username", Value: { reason: string, riddlesInSession: Array<{docId, question, roundNumber}>, expiresAt: number }
const PENDING_REPORT_TIMEOUT_MS = 60000; // 1 minute for user to reply

/*
GameState structure:
{
    channelName: string,
    topic: string | null, // e.g., 'general', 'current game', 'user-defined subject'
    state: 'idle' | 'selecting' | 'inProgress' | 'answered' | 'timeout' | 'ending',
    currentRiddle: {
        question: string,
        answer: string,
        keywords: string[], // Keywords associated with this specific riddle
        difficulty: string,
        explanation: string,
        searchUsed: boolean,
        topic: string
    } | null,
    startTime: number | null, // Timestamp for when the current riddle was asked
    riddleTimeoutTimer: NodeJS.Timeout | null,
    winner: { username: string, displayName: string } | null,
    initiatorUsername: string | null, // Lowercase username
    config: Object, // Channel-specific config merged with defaults

    totalRounds: number,
    currentRound: number,
    gameSessionScores: Map<string, { displayName: string, score: number }>, 
    // Stores SETS of keywords from riddles already used in THIS multi-round session
    gameSessionExcludedKeywordSets: Array<string[]>,
    gameSessionId: string,
    gameSessionExcludedAnswers: Array<string>,
    guessCache: Map<string, {result: Object, timestamp: number}>, // Cache for incorrect guesses this round
}
*/

async function _getOrCreateGameState(channelName) {
    if (!activeGames.has(channelName)) {
        logger.debug(`[RiddleGameManager] Creating new game state for channel: ${channelName}`);
        let loadedConfig = null;
        try {
            loadedConfig = await loadChannelRiddleConfig(channelName);
        } catch (error) {
            logger.error({ err: error, channel: channelName }, "[RiddleGameManager] Failed to load channel riddle config, using defaults.");
        }
        const finalConfig = { ...DEFAULT_RIDDLE_CONFIG, ...(loadedConfig || {}) };

        activeGames.set(channelName, {
            channelName,
            topic: null,
            state: 'idle',
            currentRiddle: null,
            startTime: null,
            riddleTimeoutTimer: null,
            winner: null,
            initiatorUsername: null,
            config: finalConfig,
            totalRounds: 1,
            currentRound: 1,
            gameSessionScores: new Map(),
            gameSessionExcludedKeywordSets: [],
            gameSessionExcludedAnswers: [],
            guessCache: new Map(),
        });
    } else {
        // Ensure config is up-to-date if manager was re-initialized
        const state = activeGames.get(channelName);
        state.config = { ...DEFAULT_RIDDLE_CONFIG, ...state.config };
        if (!state.gameSessionExcludedKeywordSets) {
            state.gameSessionExcludedKeywordSets = [];
        }
         if (!state.gameSessionScores) {
            state.gameSessionScores = new Map();
        }
    }
    return activeGames.get(channelName);
}

function _clearTimers(gameState) {
    if (gameState.riddleTimeoutTimer) {
        clearTimeout(gameState.riddleTimeoutTimer);
        gameState.riddleTimeoutTimer = null;
    }
}

async function _resetGameToIdle(gameState) {
    logger.info(`[RiddleGameManager][${gameState.channelName}] Resetting riddle game state fully to idle.`);
    _clearTimers(gameState);
    const configToPreserve = gameState.config;
    // Create a fresh state object
    await _getOrCreateGameState(gameState.channelName); //This re-initializes with defaults
    const newState = activeGames.get(gameState.channelName);
    newState.config = configToPreserve; // Restore potentially modified config

    // Explicitly clear/reset fields
    newState.topic = null;
    newState.state = 'idle';
    newState.currentRiddle = null;
    newState.startTime = null;
    newState.winner = null;
    newState.initiatorUsername = null;
    newState.totalRounds = 1;
    newState.currentRound = 1;
    newState.gameSessionScores = new Map();
    newState.gameSessionExcludedKeywordSets = [];
    newState.gameSessionExcludedAnswers = [];
    newState.guessCache = new Map();
}

function _calculatePoints(gameState, timeElapsedMs) {
    if (!gameState.config.scoreTracking) return 0;

    let points = gameState.config.pointsBase || DEFAULT_RIDDLE_CONFIG.pointsBase;

    if (gameState.config.pointsDifficultyMultiplier && gameState.currentRiddle?.difficulty) {
        switch (gameState.currentRiddle.difficulty.toLowerCase()) {
            case 'easy': points *= 1; break;
            case 'normal': points *= 1.5; break;
            case 'hard': points *= 2; break;
        }
    }

    if (gameState.config.pointsTimeBonus) {
        const totalTimeMs = (gameState.config.questionTimeSeconds || DEFAULT_RIDDLE_CONFIG.questionTimeSeconds) * 1000;
        if (totalTimeMs > 0) {
            const timeRemainingRatio = Math.max(0, (totalTimeMs - timeElapsedMs) / totalTimeMs);
            const timeBonus = Math.floor(points * 0.5 * timeRemainingRatio); // Max 50% bonus for speed
            points += timeBonus;
        }
    }
    return Math.max(1, Math.floor(points)); // Ensure at least 1 point
}

async function _transitionToEnding(gameState, reason = "answered", timeTakenMs = null) {
    _clearTimers(gameState);
    if (gameState.state === 'ending' || gameState.state === 'idle') {
        logger.warn(`[RiddleGameManager][${gameState.channelName}] Game already ${gameState.state}. Transition to ending skipped.`);
        return;
    }
    const oldState = gameState.state;
    gameState.state = 'ending'; // Mark as ending to prevent re-entry or interference
    logger.info(`[RiddleGameManager][${gameState.channelName}] Round ${gameState.currentRound}/${gameState.totalRounds} ending. Reason: ${reason}, Prev State: ${oldState}`);

    const { channelName, currentRiddle, winner, topic, config, currentRound, totalRounds } = gameState;
    let pointsAwarded = 0;

    if (currentRiddle && currentRiddle.question) {
        // Add keywords of the just-finished riddle to the session exclusion list
        if (currentRiddle.keywords && currentRiddle.keywords.length > 0) {
            gameState.gameSessionExcludedKeywordSets.push([...currentRiddle.keywords]); // Store a copy
            // Persist these keywords to Firestore
            try {
                await saveRiddleKeywords(channelName, currentRiddle.keywords);
            } catch (err) {
                logger.error({ err, channelName }, "[RiddleGameManager] Failed to save riddle keywords to Firestore.");
            }
        }

        // Save the answer for exclusion
        if (currentRiddle.answer) {
            // Add to session exclusion
            if (!gameState.gameSessionExcludedAnswers.includes(currentRiddle.answer.toLowerCase())) {
                gameState.gameSessionExcludedAnswers.push(currentRiddle.answer.toLowerCase());
            }
            // Persist to Firestore
            try {
                await saveRecentAnswer(channelName, currentRiddle.answer);
            } catch (err) {
                logger.error({ err, channelName }, "[RiddleGameManager] Failed to save recent answer to Firestore.");
            }
        }

        // Scoring
        if (reason === "answered" && winner?.username) {
            pointsAwarded = _calculatePoints(gameState, timeTakenMs || 0);
            if (config.scoreTracking) {
                try {
                    await updatePlayerScore(winner.username, channelName, pointsAwarded, winner.displayName);
                } catch (scoreError) {
                    logger.error({ err: scoreError }, `[RiddleGameManager][${channelName}] Error updating score for ${winner.username}.`);
                }
            }
            // Update session score
            if (totalRounds > 1) {
                const currentSessionScore = gameState.gameSessionScores.get(winner.username)?.score || 0;
                gameState.gameSessionScores.set(winner.username, {
                    displayName: winner.displayName,
                    score: currentSessionScore + pointsAwarded
                });
            }
        }

        // Send end message
        const roundPrefix = totalRounds > 1 ? `(Round ${currentRound}/${totalRounds}) ` : "";
        let endMessage = "";
        if (reason === "answered" && winner) {
            const seconds = timeTakenMs ? Math.round(timeTakenMs / 1000) : null;
            const timeString = seconds !== null ? ` in ${seconds}s` : "";
            const pointsInfo = pointsAwarded > 0 ? ` (+${pointsAwarded} pts)` : "";
            endMessage = formatRiddleCorrectAnswerMessage(roundPrefix, winner.displayName, currentRiddle.answer, currentRiddle.explanation, timeString, pointsInfo);
        } else if (reason === "timeout") {
            endMessage = formatRiddleTimeoutMessage(roundPrefix, currentRiddle.answer, currentRiddle.explanation);
        } else if (reason === "stopped") {
            endMessage = formatRiddleStopMessage(roundPrefix, currentRiddle.answer, currentRiddle.explanation);
        } else {
             endMessage = `${roundPrefix}The riddle is over. The answer was: ${currentRiddle.answer}. ${currentRiddle.explanation || ""}`;
        }
        enqueueMessage(`#${channelName}`, endMessage.substring(0, 490)); // Ensure message length

        // Record game result in history
        try {
            await recordRiddleResult({
                channelName,
                riddleText: currentRiddle.question,
                riddleAnswer: currentRiddle.answer,
                keywords: currentRiddle.keywords || [],
                topic: currentRiddle.topic || topic || "general",
                difficulty: currentRiddle.difficulty,
                winnerUsername: winner?.username || null,
                winnerDisplayName: winner?.displayName || null,
                startTime: gameState.startTime ? new Date(gameState.startTime).toISOString() : null,
                endTime: new Date().toISOString(),
                durationMs: gameState.startTime ? (Date.now() - gameState.startTime) : null,
                reasonEnded: reason,
                roundNumber: currentRound,
                totalRounds,
                pointsAwarded,
                searchUsed: currentRiddle.searchUsed,
                gameSessionId: gameState.gameSessionId,
            });
        } catch (storageError) {
            logger.error({ err: storageError }, `[RiddleGameManager][${channelName}] Error recording riddle result.`);
        }
    } else {
        logger.warn(`[RiddleGameManager][${channelName}] TransitionToEnding called but currentRiddle is null. Reason: ${reason}`);
         if (reason === "riddle_error") {
            enqueueMessage(`#${channelName}`, "Apologies, I couldn't come up with a riddle this time!");
        }
    }


    // Handle next step (next round or game over)
    if (reason === "stopped" || reason === "riddle_error" || (currentRound >= totalRounds)) {
        // Game fully ends
        if (totalRounds > 1 && gameState.gameSessionScores.size > 0) {
            const scoresMsg = formatRiddleSessionScoresMessage(gameState.gameSessionScores);
            enqueueMessage(`#${channelName}`, scoresMsg);
        }
        if (config.scoreTracking && (reason !== "riddle_error" || totalRounds > 1) ) { // Show leaderboard unless it was a single round riddle error
             try {
                const leaderboardData = await getLeaderboard(channelName, 5);
                const leaderboardMsg = formatRiddleLeaderboardMessage(leaderboardData, channelName);
                enqueueMessage(`#${channelName}`, leaderboardMsg);
            } catch(e){
                logger.error({e}, `Error fetching riddle leaderboard for ${channelName}`);
            }
        }
        logger.info(`[RiddleGameManager][${channelName}] Riddle game session finished. Resetting.`);
        setTimeout(() => _resetGameToIdle(gameState), config.multiRoundDelayMs || DEFAULT_RIDDLE_CONFIG.multiRoundDelayMs);
    } else {
        // Proceed to next round
        gameState.currentRound++;
        gameState.currentRiddle = null;
        gameState.startTime = null;
        gameState.winner = null;
        // Set state to 'selecting' BEFORE scheduling the next round
        gameState.state = 'selecting';
        logger.info(`[RiddleGameManager][${channelName}] Preparing for next round: ${gameState.currentRound}. State set to 'selecting'.`);
        setTimeout(() => _startNextRound(gameState), config.multiRoundDelayMs || DEFAULT_RIDDLE_CONFIG.multiRoundDelayMs);
    }
}

async function _startNextRound(gameState) {
    if (gameState.state === 'ending' || gameState.state === 'idle') {
         logger.warn(`[RiddleGameManager][${gameState.channelName}] Attempted to start next round while game is ${gameState.state}. Aborting.`);
        return;
    }
    logger.info(`[RiddleGameManager][${gameState.channelName}] Starting round ${gameState.currentRound}/${gameState.totalRounds}`);

    let generatedRiddle = null;
    let retries = 0;
    const { channelName, topic, config } = gameState;

    // Fetch recent keywords from Firestore for broader exclusion + session exclusions
    let combinedExcludedKeywordSets = [...gameState.gameSessionExcludedKeywordSets];
    let excludedAnswers = [...gameState.gameSessionExcludedAnswers];
    try {
        const recentGlobalKeywords = await getRecentKeywords(channelName, config.recentKeywordsFetchLimit || DEFAULT_RIDDLE_CONFIG.recentKeywordsFetchLimit);
        if (recentGlobalKeywords.length > 0) {
            recentGlobalKeywords.forEach(globalSet => {
                if (!combinedExcludedKeywordSets.some(sessionSet => JSON.stringify(sessionSet.sort()) === JSON.stringify(globalSet.sort()))) {
                    combinedExcludedKeywordSets.push(globalSet);
                }
            });
        }
        // Fetch recent answers for exclusion
        const recentGlobalAnswers = await getRecentAnswers(channelName, 15);
        recentGlobalAnswers.forEach(ans => {
            if (!excludedAnswers.includes(ans)) {
                excludedAnswers.push(ans);
            }
        });
        logger.debug(`[RiddleGameManager][${channelName}] Total ${excludedAnswers.length} answers for exclusion.`);
    } catch (error) {
        logger.error({ err: error, channelName }, "[RiddleGameManager] Failed to fetch recent global keywords/answers for exclusion.");
    }


    while (!generatedRiddle && retries < (config.maxRiddleGenerationRetries || DEFAULT_RIDDLE_CONFIG.maxRiddleGenerationRetries)) {
        try {
            generatedRiddle = await generateRiddle(topic, config.difficulty, combinedExcludedKeywordSets, channelName, excludedAnswers);
            if (generatedRiddle && generatedRiddle.question && generatedRiddle.answer && generatedRiddle.keywords) {
                // Optional: Could add a check here to see if the *new* riddle's keywords heavily overlap with an excluded set,
                // though the LLM should ideally handle this. For now, we trust the LLM's avoidance.
                break; 
            } else {
                logger.warn(`[RiddleGameManager][${channelName}] Riddle generation attempt ${retries + 1} failed or returned invalid data.`);
                generatedRiddle = null; // Ensure it's null for retry
            }
        } catch (error) {
            logger.error({ err: error }, `[RiddleGameManager][${channelName}] Error during riddle generation attempt ${retries + 1}.`);
        }
        retries++;
        if (!generatedRiddle && retries < (config.maxRiddleGenerationRetries || DEFAULT_RIDDLE_CONFIG.maxRiddleGenerationRetries)) {
            await new Promise(resolve => setTimeout(resolve, 750)); // Wait before retrying
        }
    }

    if (!generatedRiddle) {
        logger.error(`[RiddleGameManager][${channelName}] Failed to generate riddle after ${retries} attempts. Ending game.`);
        enqueueMessage(`#${channelName}`, `I'm stumped! Couldn't think of a new riddle for round ${gameState.currentRound}. Ending the game.`);
        await _transitionToEnding(gameState, "riddle_error");
        return;
    }

    gameState.currentRiddle = generatedRiddle;
    gameState.startTime = Date.now();
    gameState.state = 'inProgress'; // Set state before sending message
    gameState.guessCache.clear(); // Clear cache for the new round

    const questionMsg = formatRiddleQuestionMessage(
        gameState.currentRound,
        gameState.totalRounds,
        gameState.currentRiddle.question,
        gameState.currentRiddle.difficulty,
        config.questionTimeSeconds
    );
    enqueueMessage(`#${channelName}`, questionMsg);

    const timeoutMs = (config.questionTimeSeconds || DEFAULT_RIDDLE_CONFIG.questionTimeSeconds) * 1000;
    gameState.riddleTimeoutTimer = setTimeout(async () => {
        if (gameState.state === 'inProgress') { // Check state again inside timeout
            logger.info(`[RiddleGameManager][${channelName}] Riddle for round ${gameState.currentRound} timed out.`);
            await _transitionToEnding(gameState, "timeout");
        }
    }, timeoutMs);
    logger.info(`[RiddleGameManager][${channelName}] Round ${gameState.currentRound} started. Timer set for ${timeoutMs}ms.`);
}

async function _handleAnswer(channelName, username, displayName, message) {
    const gameState = activeGames.get(channelName);
    if (!gameState || gameState.state !== 'inProgress' || !gameState.currentRiddle) {
        return;
    }

    // Spam prevention
    const lastGuessTime = gameState.userLastGuessTime?.[username.toLowerCase()];
    if (lastGuessTime && (Date.now() - lastGuessTime < 2000)) {
        return;
    }
    if (!gameState.userLastGuessTime) gameState.userLastGuessTime = {};
    gameState.userLastGuessTime[username.toLowerCase()] = Date.now();

    const userAnswer = message.trim();
    if (!userAnswer) return;

    // Check the cache for this normalized answer first
    const normalizedUserAnswer = userAnswer.toLowerCase().trim();
    if (gameState.guessCache.has(normalizedUserAnswer)) {
        logger.debug(`[RiddleGameManager][${channelName}] Answer "${userAnswer}" found in incorrect guess cache. Skipping LLM verification.`);
        return; // It's a known wrong answer for this round, do nothing.
    }

    logger.debug(`[RiddleGameManager][${channelName}] Processing answer "${userAnswer}" from ${displayName} for round ${gameState.currentRound}`);

    // Added: Translate user's answer if botlang is set
    const contextManager = getContextManager();
    const botLanguage = contextManager.getBotLanguage(channelName);
    let answerToVerify = userAnswer;

    if (botLanguage && botLanguage.toLowerCase() !== 'english' && botLanguage.toLowerCase() !== 'en') {
        logger.debug(`[RiddleGameManager][${channelName}] Bot language is ${botLanguage}. Translating user answer "${userAnswer}" to English for verification.`);
        try {
            const translatedUserAnswer = await translateText(userAnswer, 'English');
            if (translatedUserAnswer && translatedUserAnswer.trim().length > 0) {
                answerToVerify = translatedUserAnswer.trim();
                logger.info(`[RiddleGameManager][${channelName}] Translated user answer for verification: "${userAnswer}" -> "${answerToVerify}"`);
            } else {
                logger.warn(`[RiddleGameManager][${channelName}] Translation of answer "${userAnswer}" to English resulted in empty string. Using original for verification.`);
            }
        } catch (translateError) {
            logger.error({ err: translateError, channelName, userAnswer, botLanguage }, `[RiddleGameManager][${channelName}] Failed to translate user answer to English for verification. Using original.`);
        }
    }
    // End of added translation logic

    try {
        const originalRequestedTopic = gameState.topic;
        const verification = await verifyRiddleAnswer(
            gameState.currentRiddle.answer,
            answerToVerify, // Use the potentially translated answer
            gameState.currentRiddle.question,
            originalRequestedTopic
        );

        if (gameState.state !== 'inProgress') {
            logger.debug(`[RiddleGameManager][${channelName}] Game state changed to ${gameState.state} while verifying answer for ${displayName}. Ignoring result.`);
            return;
        }

        if (verification && verification.isCorrect) {
            logger.info(`[RiddleGameManager][${channelName}] Correct answer from ${displayName} for round ${gameState.currentRound}. Confidence: ${verification.confidence.toFixed(2)}`);
            gameState.winner = { username: username.toLowerCase(), displayName };
            const timeTakenMs = Date.now() - gameState.startTime;
            await _transitionToEnding(gameState, "answered", timeTakenMs);
        } else {
            // Cache the incorrect answer to prevent re-verification
            gameState.guessCache.set(normalizedUserAnswer, {
                result: verification,
                timestamp: Date.now()
            });
            logger.debug(`[RiddleGameManager][${channelName}] Caching incorrect guess: "${userAnswer}"`);
        }
    } catch (error) {
        logger.error({ err: error }, `[RiddleGameManager][${channelName}] Error verifying answer from ${displayName}.`);
    }
}

// --- Public API ---
export async function initializeRiddleGameManager() {
    logger.info("Initializing Riddle Game Manager...");
    activeGames.clear();
    // Could potentially load all channel configs here if needed on startup
    logger.info("Riddle Game Manager initialized.");
}

export async function startGame(channelName, topic = null, initiatorUsername = null, numberOfRounds = 1) {
    const gameState = await _getOrCreateGameState(channelName);

    if (gameState.state !== 'idle') {
        logger.warn(`[RiddleGameManager][${channelName}] Start requested by ${initiatorUsername} but game state is ${gameState.state}.`);
        const gameInProgressMsg = `A riddle game is already in progress (round ${gameState.currentRound}/${gameState.totalRounds}, started by @${gameState.initiatorUsername || 'Unknown'}).`;
        return { success: false, error: gameInProgressMsg };
    }
    gameState.gameSessionId = crypto.randomUUID();
    logger.info(`[RiddleGameManager][${channelName}] New game starting by ${initiatorUsername}. Rounds: ${numberOfRounds}. Generated new gameSessionId: ${gameState.gameSessionId}`);

    // Reset/Initialize fields for a new game session
    gameState.topic = topic;
    gameState.initiatorUsername = initiatorUsername ? initiatorUsername.toLowerCase() : null;
    gameState.totalRounds = Math.min(Math.max(1, Number(numberOfRounds) || 1), gameState.config.maxRounds || DEFAULT_RIDDLE_CONFIG.maxRounds);
    gameState.currentRound = 1;
    gameState.gameSessionScores = new Map();
    gameState.gameSessionExcludedKeywordSets = []; // Fresh set for new game
    gameState.gameSessionExcludedAnswers = [];
    gameState.guessCache = new Map();
    gameState.currentRiddle = null;
    gameState.startTime = null;
    gameState.winner = null;
    _clearTimers(gameState);

    gameState.state = 'selecting'; // Mark as selecting before async operations

    const startMessage = formatRiddleStartMessage(
        topic, // Let formatter handle if topic is null
        gameState.config.questionTimeSeconds,
        gameState.totalRounds
    );
    enqueueMessage(`#${channelName}`, startMessage);
    
    // Start the first round
    await _startNextRound(gameState); 
    if(gameState.state === 'idle'){ // Game failed to start properly
        return { success: false, error: "Failed to start the riddle game. Could not generate the first riddle."};
    }
    return { success: true };
}

export function stopGame(channelName) {
    const gameState = activeGames.get(channelName);
    if (!gameState || gameState.state === 'idle' || gameState.state === 'ending') {
        logger.debug(`[RiddleGameManager][${channelName}] Stop command, but no active/stoppable game.`);
        return { message: "No active riddle game to stop." };
    }
    logger.info(`[RiddleGameManager][${channelName}] Game stop requested. Current state: ${gameState.state}`);
    // _transitionToEnding will send the actual "game stopped" message with answer.
    _transitionToEnding(gameState, "stopped"); 
    return { message: "Riddle game is being stopped." }; // Confirmation to initiator
}

export function processPotentialAnswer(channelName, username, displayName, message) {
    const gameState = activeGames.get(channelName);
    if (gameState && gameState.state === 'inProgress' && !message.startsWith('!')) {
        _handleAnswer(channelName, username.toLowerCase(), displayName, message).catch(err => {
            logger.error({ err, channel: channelName, user: displayName }, `[RiddleGameManager] Unhandled error processing answer in processPotentialAnswer.`);
        });
    }
}

export async function configureRiddleGame(channelName, options) {
    const gameState = await _getOrCreateGameState(channelName);
    let changed = false;
    const appliedChanges = [];

    if (options.difficulty && ['easy', 'normal', 'hard'].includes(options.difficulty.toLowerCase())) {
        gameState.config.difficulty = options.difficulty.toLowerCase();
        appliedChanges.push(`Difficulty set to ${gameState.config.difficulty}`);
        changed = true;
    }
    if (options.questionTimeSeconds) {
        const time = parseInt(options.questionTimeSeconds, 10);
        if (!isNaN(time) && time >= 15 && time <= 120) {
            gameState.config.questionTimeSeconds = time;
            appliedChanges.push(`Question time set to ${time}s`);
            changed = true;
        } else {
             appliedChanges.push(`Invalid question time (15-120s)`);
        }
    }
    // Add other config options here: pointsBase, scoreTracking, etc.

    if (changed) {
        try {
            await saveChannelRiddleConfig(channelName, gameState.config);
            logger.info(`[RiddleGameManager][${channelName}] Riddle config updated: ${appliedChanges.join(', ')}`);
            return { message: `Riddle settings updated: ${appliedChanges.join('. ')}.` };
        } catch (e) {
            logger.error({e}, `Failed to save riddle config for ${channelName}`);
            return { message: `Settings changed in memory but failed to save.`};
        }
    }
    return { message: appliedChanges.length > 0 ? `Riddle settings: ${appliedChanges.join('. ')}.` : "No valid riddle settings changed." };
}

export async function resetRiddleConfig(channelName) {
    const gameState = await _getOrCreateGameState(channelName);
    gameState.config = { ...DEFAULT_RIDDLE_CONFIG };
     try {
        await saveChannelRiddleConfig(channelName, gameState.config);
        logger.info(`[RiddleGameManager][${channelName}] Riddle config reset to defaults.`);
        return { message: "Riddle game configuration reset to defaults." };
    } catch (e) {
        logger.error({e}, `Failed to save reset riddle config for ${channelName}`);
        return { message: `Config reset in memory but failed to save.`};
    }
}

export function getCurrentGameInitiator(channelName) {
    const gameState = activeGames.get(channelName);
    if (gameState && gameState.state !== 'idle') {
        return gameState.initiatorUsername;
    }
    return null;
}

export async function clearLeaderboard(channelName) {
    logger.info(`[RiddleGameManager][${channelName}] Clearing riddle leaderboard data.`);
    try {
        const result = await clearRiddleLeaderboardData(channelName);
        return { success: true, message: result.message };
    } catch (e) {
         logger.error({ err: e, channelName }, '[RiddleGameManager] Error clearing riddle leaderboard');
        return { success: false, message: e.message || "Failed to clear riddle leaderboard." };
    }
}

/**
 * Gets the details of the last played riddle in a channel.
 * Used by the report command.
 * @param {string} channelName - Channel name (without #).
 * @returns {Promise<{question: string, answer: string, docId: string}|null>}
 */
async function getLastPlayedRiddleDetails(channelName) {
    try {
        const riddleDetails = await getMostRecentRiddlePlayed(channelName);
        if (riddleDetails) {
            logger.info(`[RiddleGameManager][${channelName}] Last played riddle details fetched: Q: ${riddleDetails.question ? riddleDetails.question.substring(0,30) : ''}...`);
            return riddleDetails; // Contains docId, question, answer
        }
        logger.info(`[RiddleGameManager][${channelName}] No last played riddle found to report.`);
        return null;
    } catch (error) {
        logger.error({ err: error, channelName }, `[RiddleGameManager][${channelName}] Error getting last played riddle details.`);
        return null;
    }
}

/**
 * Reports the last played riddle in the channel as problematic.
 * @param {string} channelName - Channel name (without #).
 * @param {string} reason - Reason for reporting.
 * @param {string} reportedByUsername - Username of the reporter.
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function reportLastRiddle(channelName, reason, reportedByUsername) {
    logger.info(`[RiddleGameManager][${channelName}] Attempting to report last riddle. Reason: "${reason}", Reported by: ${reportedByUsername}`);
    const lastRiddle = await getLastPlayedRiddleDetails(channelName);

    if (!lastRiddle || !lastRiddle.docId) {
        return { success: false, message: "I couldn't find a recently played riddle in this channel to report." };
    }

    if (!lastRiddle.question) {
         logger.warn(`[RiddleGameManager][${channelName}] Last riddle found (ID: ${lastRiddle.docId}) but has no question text. Cannot report effectively.`);
        return { success: false, message: "The last riddle found seems incomplete and cannot be reported." };
    }

    try {
        await flagRiddleAsProblem(lastRiddle.docId, reason, reportedByUsername);
        logger.info(`[RiddleGameManager][${channelName}] Successfully reported riddle: "${lastRiddle.question.substring(0, 50)}..."`);
        return { success: true, message: `Thanks for the feedback! The riddle starting with "${lastRiddle.question.substring(0, 30)}..." has been reported.` };
    } catch (error) {
        logger.error({ err: error, channelName }, `[RiddleGameManager][${channelName}] Error reporting riddle via storage.`);
        return { success: false, message: "Sorry, an error occurred while trying to report the riddle." };
    }
}

/**
 * Gets the singleton RiddleGameManager instance.
 */
let riddleGameManagerInstance = null;
export function getRiddleGameManager() {
    if (!riddleGameManagerInstance) {
        riddleGameManagerInstance = {
            initialize: initializeRiddleGameManager,
            startGame,
            stopGame,
            processPotentialAnswer,
            configureGame: configureRiddleGame,
            resetConfig: resetRiddleConfig,
            getCurrentGameInitiator,
            clearLeaderboard,
            reportLastRiddle,
            initiateReportProcess,
            finalizeReportWithRoundNumber,
        };
    }
    return riddleGameManagerInstance;
}

// Export activeGames for testing
export { activeGames };

async function initiateReportProcess(channelName, reason, reportedByUsername) {
    logger.info(`[RiddleGameManager][${channelName}] Initiating report process. Reason: "${reason}", By: ${reportedByUsername}`);
    const sessionInfo = await getLatestCompletedSessionInfo(channelName);

    // Detailed logging of sessionInfo
    logger.debug(`[RiddleGameManager][${channelName}] sessionInfo received from getLatestCompletedSessionInfo: gameSessionId=${sessionInfo?.gameSessionId}, totalRounds=${sessionInfo?.totalRounds}, riddlesInSessionCount=${sessionInfo?.riddlesInSession?.length}`);
    if (sessionInfo && sessionInfo.riddlesInSession && sessionInfo.riddlesInSession.length > 0) {
        sessionInfo.riddlesInSession.forEach((r, idx) => logger.debug(`[RiddleGameManager][${channelName}] Session Riddle [${idx}]: Round ${r.roundNumber}, Q: ${r.question?.substring(0,20)}...`));
    }

    if (!sessionInfo || !sessionInfo.riddlesInSession || sessionInfo.riddlesInSession.length === 0) {
        logger.warn(`[RiddleGameManager][${channelName}] getLatestCompletedSessionInfo returned insufficient data. sessionInfo: ${JSON.stringify(sessionInfo, null, 2)}`);
        return { success: false, message: "I couldn't find any recent riddles in this channel to report." };
    }

    const totalRoundsFromInfo = sessionInfo.totalRounds;
    const riddlesFoundInSession = sessionInfo.riddlesInSession;

    logger.debug(`[RiddleGameManager][${channelName}] Session Info for report decision: totalRoundsFromInfo=${totalRoundsFromInfo}, found ${riddlesFoundInSession.length} riddles in session array.`);

    if (totalRoundsFromInfo > 1 && riddlesFoundInSession.length > 1) {
        logger.info(`[RiddleGameManager][${channelName}] Multi-round report scenario. Prompting user for round number.`);
        // Multi-round game, ask for clarification
        const reportKey = `${channelName}_${reportedByUsername.toLowerCase()}`;
        pendingReports.set(reportKey, {
            reason,
            riddlesInSession: riddlesFoundInSession, // Store [{docId, question, roundNumber}, ...]
            reportedByUsername,
            expiresAt: Date.now() + PENDING_REPORT_TIMEOUT_MS
        });

        setTimeout(() => {
            if (pendingReports.has(reportKey) && pendingReports.get(reportKey).expiresAt <= Date.now()) {
                pendingReports.delete(reportKey);
                logger.info(`[RiddleGameManager] Expired pending report for ${reportKey}`);
            }
        }, PENDING_REPORT_TIMEOUT_MS + 1000);
        
        let promptMessage = `@${reportedByUsername}, the last riddle game had ${totalRoundsFromInfo} rounds. Which round (1-${totalRoundsFromInfo}) is your report about? Reply with just the number.`;
        if (riddlesFoundInSession.length < totalRoundsFromInfo) {
            promptMessage = `@${reportedByUsername}, I found ${riddlesFoundInSession.length} riddles from the last session (expected ${totalRoundsFromInfo}). Which round (1-${riddlesFoundInSession.length}) is your report about? Reply with the number.`
        }
        return { success: true, message: promptMessage, needsFollowUp: true };
    } else {
        logger.info(`[RiddleGameManager][${channelName}] Single riddle report scenario. totalRoundsFromInfo: ${totalRoundsFromInfo}, riddlesFoundInSession.length: ${riddlesFoundInSession.length}`);
        const riddleToReport = riddlesFoundInSession[0];
        if (!riddleToReport || !riddleToReport.docId) {
             return { success: false, message: "Could not identify a specific riddle to report." };
        }
        try {
            await flagRiddleAsProblem(riddleToReport.docId, reason, reportedByUsername);
            logger.info(`[RiddleGameManager][${channelName}] Successfully reported single/latest riddle: "${riddleToReport.question.substring(0, 50)}..."`);
            return { success: true, message: `Thanks for the feedback! The riddle ("${riddleToReport.question.substring(0, 30)}...") has been reported.` };
        } catch (error) {
            logger.error({ err: error, channelName }, `[RiddleGameManager][${channelName}] Error reporting single/latest riddle via storage.`);
            return { success: false, message: "Sorry, an error occurred while trying to report the riddle." };
        }
    }
}

async function finalizeReportWithRoundNumber(channelName, username, roundNumberStr) {
    const reportKey = `${channelName}_${username.toLowerCase()}`;
    const pendingData = pendingReports.get(reportKey);

    if (!pendingData) {
        return { success: false, message: null }; // No pending report for this user, or it expired
    }

    const roundNum = parseInt(roundNumberStr, 10);
    if (isNaN(roundNum) || roundNum < 1 || roundNum > pendingData.riddlesInSession.length) {
        return { success: true, message: `@${username}, that's not a valid round number (1-${pendingData.riddlesInSession.length}). Please try reporting again.` };
    }

    const riddleToReport = pendingData.riddlesInSession.find(r => r.roundNumber === roundNum);

    if (!riddleToReport || !riddleToReport.docId) {
        pendingReports.delete(reportKey); // Clean up
        return { success: true, message: `@${username}, I couldn't find the riddle for round ${roundNum}. Please try reporting again.` };
    }

    try {
        await flagRiddleAsProblem(riddleToReport.docId, pendingData.reason, pendingData.reportedByUsername);
        pendingReports.delete(reportKey); // Clean up successful report
        logger.info(`[RiddleGameManager][${channelName}] Successfully finalized report for round ${roundNum}, riddle ID ${riddleToReport.docId}`);
        return { success: true, message: `@${username}, thanks! Your report for the riddle from round ${roundNum} ("${riddleToReport.question.substring(0, 30)}...") has been submitted.` };
    } catch (error) {
        pendingReports.delete(reportKey); // Clean up even on error
        logger.error({ err: error, channelName }, `[RiddleGameManager][${channelName}] Error finalizing report for round ${roundNum}.`);
        return { success: true, message: `@${username}, an error occurred submitting your report for round ${roundNum}. Please try again.` };
    }
}
