import logger from '../../lib/logger.js';
import { enqueueMessage } from '../../lib/ircSender.js';
import { getContextManager } from '../context/contextManager.js';
import { translateText } from '../../lib/translationUtils.js';
import { selectLocation, validateGuess } from './geoLocationService.js';
import { generateInitialClue, generateFollowUpClue, generateFinalReveal } from './geoClueService.js';
import { formatStartMessage, formatClueMessage, formatCorrectGuessMessage, formatTimeoutMessage, formatStopMessage, formatStartNextRoundMessage, formatGameSessionScoresMessage } from './geoMessageFormatter.js';
import { loadChannelConfig, saveChannelConfig, recordGameResult, updatePlayerScore, getRecentLocations, getLeaderboard, clearChannelLeaderboardData, reportProblemLocation, getLatestCompletedSessionInfo as getLatestGeoSession, flagGeoLocationByDocId } from './geoStorage.js';
import { summarizeText } from '../llm/geminiClient.js';
import crypto from 'crypto';

// --- Game State & Config Interfaces (Conceptual) ---
/*
interface GameConfig {
    difficulty: 'easy' | 'normal' | 'hard';
    clueIntervalSeconds: number; // 30-300
    roundDurationMinutes: number; // 5-15
    scoreTracking: boolean;
    // Scoring Additions
    pointsBase?: number; // Base points for a correct guess
    pointsTimeBonus?: boolean; // Whether to give bonus points for fast answers
    pointsDifficultyMultiplier?: boolean; // Whether to multiply points by difficulty
    // --- End Scoring Additions ---
    // Real World Mode specific
    regionRestrictions?: string[]; // Continents, countries
    // Video Game Mode specific
    gameTitlePreferences?: string[];
}

interface PlayerGuess {
    username: string;
    displayName: string;
    guess: string;
    timestamp: Date;
}

interface GameState {
    channelName: string;
    mode: 'real' | 'game';
    state: 'idle' | 'selecting' | 'started' | 'inProgress' | 'guessed' | 'timeout' | 'ending';
    targetLocation: { name: string, alternateNames?: string[] } | null; // Store main name + alternates
    gameTitleScope: string | null; // For video game mode
    sessionRegionScope: string | null; // For user-specified region in 'real' mode for the session
    startTime: number | null; // timestamp ms
    clues: string[];
    currentClueIndex: number;
    nextClueTimer: NodeJS.Timeout | null;
    roundEndTimer: NodeJS.Timeout | null;
    guesses: PlayerGuess[];
    winner: { username: string, displayName: string } | null;
    initiatorUsername: string | null; // Store the lowercase username of the initiator
    config: GameConfig; // Channel-specific config
    lastMessageTimestamp: number; // To help throttle guesses if needed
    incorrectGuessReasons: string[]; // Added to store reasons for incorrect guesses

    // --- NEW FIELD ---
    lastPlayedLocation: string | null; // Stores the name of the most recently finished location

    // --- Multi-Round Fields ---
    totalRounds: number; // Total number of rounds requested
    currentRound: number; // Current round number (1-based)
    gameSessionScores: Map<string, { displayName: string; score: number }>; // username -> { displayName, score } for the current multi-round game
    gameSessionExcludedLocations: Set<string>; // Locations used in the current multi-round session

    // --- NEW FIELDS ---
    streakMap: Map<string, number>; // username -> consecutive correct guesses
    guessCache: Map<string, {result: Object, timestamp: number}>; // Cache for incorrect guesses this round

    // --- PHASE 1 ---
    gameSessionId: string | null; // Add this field
}
*/

// --- Default Configuration ---
const DEFAULT_CONFIG = {
    difficulty: 'normal',
    clueIntervalSeconds: 45,
    roundDurationMinutes: 5,
    scoreTracking: true,
    // Scoring defaults
    pointsBase: 15,
    pointsTimeBonus: true,
    pointsDifficultyMultiplier: true,
    // --- End Scoring defaults ---
    regionRestrictions: [],
    gameTitlePreferences: [],
};

const MAX_IRC_MESSAGE_LENGTH = 450; // Should match ircSender.js
const SUMMARY_TARGET_LENGTH = 400; // Slightly less than max to allow for prefixes
const MULTI_ROUND_DELAY_MS = 5000; // Delay between rounds

// --- In-Memory Storage for Active Games ---
/** @type {Map<string, GameState>} */
const activeGames = new Map(); // channelName -> GameState

const pendingGeoReports = new Map();
const PENDING_GEO_REPORT_TIMEOUT_MS = 60000;

// --- Helper Functions ---
async function _getOrCreateGameState(channelName) {
    if (!activeGames.has(channelName)) {
        logger.debug(`[GeoGame] Creating new game state for channel: ${channelName}`);
        let loadedConfig = null;
        try {
            loadedConfig = await loadChannelConfig(channelName);
        } catch (error) {
            logger.error({ err: error, channel: channelName }, "[GeoGame] Failed to load channel config from storage, using defaults.");
        }
        const finalConfig = { ...DEFAULT_CONFIG, ...(loadedConfig || {}) };
        activeGames.set(channelName, {
            channelName,
            mode: 'real',
            state: 'idle',
            targetLocation: null,
            gameTitleScope: null,
            sessionRegionScope: null,
            startTime: null,
            clues: [],
            currentClueIndex: -1,
            nextClueTimer: null,
            roundEndTimer: null,
            guesses: [],
            winner: null,
            initiatorUsername: null,
            config: finalConfig,
            lastMessageTimestamp: 0,
            incorrectGuessReasons: [],
            lastPlayedLocation: null,
            streakMap: new Map(),
            guessCache: new Map(),
            gameSessionId: null,
            totalRounds: 1,
            currentRound: 1,
            gameSessionScores: new Map(),
            gameSessionExcludedLocations: new Set(),
        });
    } else {
        const state = activeGames.get(channelName);
        if (!state.streakMap) state.streakMap = new Map();
        if (!state.guessCache) state.guessCache = new Map();
        if (state.lastPlayedLocation === undefined) state.lastPlayedLocation = null;
        state.config = { ...DEFAULT_CONFIG, ...state.config };
    }
    return activeGames.get(channelName);
}

function _clearTimers(gameState) {
    if (gameState.nextClueTimer) clearTimeout(gameState.nextClueTimer);
    if (gameState.roundEndTimer) clearTimeout(gameState.roundEndTimer);
    gameState.nextClueTimer = null;
    gameState.roundEndTimer = null;
}

// Function to fully reset the game state to idle, clearing multi-round info
async function _resetGameToIdle(gameState) {
    logger.info(`[GeoGame][${gameState.channelName}] Resetting game state fully to idle.`);
    _clearTimers(gameState);
    const config = gameState.config;
    const newState = await _getOrCreateGameState(gameState.channelName);
    newState.config = config;
    newState.state = 'idle';
    newState.targetLocation = null;
    newState.gameTitleScope = null;
    newState.sessionRegionScope = null;
    newState.startTime = null;
    newState.clues = [];
    newState.currentClueIndex = -1;
    newState.guesses = [];
    newState.winner = null;
    newState.incorrectGuessReasons = [];
    newState.initiatorUsername = null;
    newState.streakMap = new Map();
    newState.guessCache = new Map();
    newState.totalRounds = 1;
    newState.currentRound = 1;
    newState.gameSessionScores = new Map();
    newState.gameSessionExcludedLocations = new Set();
}

async function _transitionToEnding(gameState, reason = "guessed", timeTakenMs = null) {
    if (gameState.targetLocation?.name) {
        gameState.lastPlayedLocation = gameState.targetLocation.name;
        logger.debug(`[GeoGame][${gameState.channelName}] Storing last played location: ${gameState.lastPlayedLocation}`);
    }
    _clearTimers(gameState);
    if (gameState.state === 'ending' || gameState.state === 'idle') {
        logger.warn(`[GeoGame][${gameState.channelName}] Game state is already '${gameState.state}'. Ignoring transition request (Reason: ${reason}).`);
        return;
    }
    gameState.state = 'ending';
    logger.info(`[GeoGame][${gameState.channelName}] Round ${gameState.currentRound}/${gameState.totalRounds} ending. Reason: ${reason}`);
    const isMultiRound = gameState.totalRounds > 1;
    const isLastRound = gameState.currentRound === gameState.totalRounds;
    let points = 0;
    if (reason === "guessed" && gameState.winner?.username) {
        const winnerUsername = gameState.winner.username;
        const winnerDisplayName = gameState.winner.displayName;
        points = _calculatePoints(gameState, timeTakenMs || 0);
        logger.info(`[GeoGame][${gameState.channelName}] Awarding ${points} points to ${winnerUsername} for round ${gameState.currentRound}.`);
        const currentStreak = gameState.streakMap.get(winnerUsername) || 0;
        gameState.streakMap.set(winnerUsername, currentStreak + 1);
        logger.debug(`[GeoGame][${gameState.channelName}] Updated streak for ${winnerUsername} to ${currentStreak + 1}`);
        if (isMultiRound) {
            const currentSessionScore = gameState.gameSessionScores.get(winnerUsername)?.score || 0;
            gameState.gameSessionScores.set(winnerUsername, {
                displayName: winnerDisplayName,
                score: currentSessionScore + points
            });
            logger.debug(`[GeoGame][${gameState.channelName}] Updated session score for ${winnerUsername}: ${currentSessionScore + points}`);
        }
        if (gameState.config.scoreTracking) {
            try {
                logger.debug(`[GeoGame][${gameState.channelName}] Calling updatePlayerScore for ${winnerUsername} with ${points} points.`);
                await updatePlayerScore(winnerUsername, gameState.channelName, points, winnerDisplayName);
                logger.debug(`[GeoGame][${gameState.channelName}] Successfully awaited updatePlayerScore for ${winnerUsername}.`);
            } catch (scoreError) {
                logger.error({ err: scoreError }, `[GeoGame][${gameState.channelName}] Error caught from updatePlayerScore call.`);
            }
        }
    } else {
        if (gameState.streakMap && gameState.streakMap.size > 0) {
            logger.debug(`[GeoGame][${gameState.channelName}] Resetting streaks due to round end reason: ${reason}`);
            gameState.streakMap.clear();
        }
    }
    let revealText = null;
    let roundEndMessage = "";
    if (!gameState.targetLocation?.name) {
        logger.error(`[GeoGame][${gameState.channelName}] Cannot generate round reveal: targetLocation is missing.`);
        roundEndMessage = "An error occurred, and the round's location couldn't be revealed.";
    } else {
        try {
            revealText = await generateFinalReveal(gameState.targetLocation.name, gameState.mode, gameState.gameTitleScope, reason);
            let baseMessageContent = "";
            const roundPrefix = isMultiRound ? `(Round ${gameState.currentRound}/${gameState.totalRounds}) ` : "";
            if (reason === "guessed" && gameState.winner) {
                const currentStreak = gameState.streakMap.get(gameState.winner.username) || 1;
                const streakInfo = currentStreak > 1 ? ` 🔥x${currentStreak}` : '';
                const pointsInfo = points > 0 ? ` (+${points} pts)` : '';
                baseMessageContent = formatCorrectGuessMessage(
                    gameState.winner.displayName,
                    gameState.targetLocation.name,
                    timeTakenMs,
                    streakInfo,
                    pointsInfo
                );
                baseMessageContent = `${roundPrefix}${baseMessageContent} ${revealText || '(Summary unavailable)'}`;
            } else if (reason === "timeout") {
                baseMessageContent = `${roundPrefix}${formatTimeoutMessage(gameState.targetLocation.name)} ${revealText || '(Summary unavailable)'}`;
            } else if (reason === "stopped") {
                baseMessageContent = `${roundPrefix}${formatStopMessage(gameState.targetLocation.name)} ${revealText || '(Summary unavailable)'}`;
            } else {
                baseMessageContent = `${roundPrefix}📢 The answer was: ${gameState.targetLocation.name}! ${revealText || '(Summary unavailable)'}`;
            }
            roundEndMessage = baseMessageContent;
            if (roundEndMessage.length > MAX_IRC_MESSAGE_LENGTH) {
                logger.info(`[GeoGame][${gameState.channelName}] Round end message too long (${roundEndMessage.length} chars). Attempting summarization.`);
                let prefix = "";
                if (reason === "guessed" && gameState.winner) {
                    const seconds = typeof timeTakenMs === 'number' ? Math.round(timeTakenMs / 1000) : null;
                    const timeString = seconds !== null ? ` in ${seconds}s` : '';
                    const currentStreak = gameState.streakMap.get(gameState.winner.username) || 1;
                    const streakInfo = currentStreak > 1 ? ` 🔥x${currentStreak}` : '';
                    const pointsInfo = points > 0 ? ` (+${points} pts)` : '';
                    prefix = `${roundPrefix}✅ @${gameState.winner.displayName} guessed: ${gameState.targetLocation.name}${timeString}${streakInfo}${pointsInfo}! `;
                } else if (reason === "timeout") {
                    prefix = `${roundPrefix}⏱️ Time's up! The location was ${gameState.targetLocation.name}. `;
                } else if (reason === "stopped") {
                    prefix = `${roundPrefix}🛑 Game stopped. The location was ${gameState.targetLocation.name}. `;
                } else {
                    prefix = `${roundPrefix}📢 The answer was: ${gameState.targetLocation.name}! `;
                }
                try {
                    const summaryInput = revealText || baseMessageContent;
                    const summary = await summarizeText(summaryInput, SUMMARY_TARGET_LENGTH);
                    if (summary?.trim()) {
                        roundEndMessage = prefix + summary.trim();
                        logger.info(`[GeoGame][${gameState.channelName}] Summarization successful (${roundEndMessage.length} chars).`);
                    } else {
                        logger.warn(`[GeoGame][${gameState.channelName}] Summarization failed. Falling back to original (potentially truncated by IRC).`);
                        roundEndMessage = baseMessageContent;
                    }
                } catch (summaryError) {
                    logger.error({ err: summaryError }, `[GeoGame][${gameState.channelName}] Error during summarization. Falling back to original.`);
                    roundEndMessage = baseMessageContent;
                }
            }
        } catch (error) {
            logger.error({ err: error }, `[GeoGame][${gameState.channelName}] Error generating round reveal or formatting message.`);
            roundEndMessage = `An error occurred revealing the answer for round ${gameState.currentRound}.`;
        }
    }
    enqueueMessage(`#${gameState.channelName}`, roundEndMessage || "The round has ended.");
    logger.debug(`[GeoGame][${gameState.channelName}] Round end message sent.`);
    if (gameState.config.scoreTracking && gameState.targetLocation?.name && ['guessed', 'timeout', 'stopped'].includes(reason)) {
        try {
            const gameDetails = {
                channel: gameState.channelName,
                mode: gameState.mode,
                location: gameState.targetLocation.name,
                gameTitle: gameState.gameTitleScope,
                winner: gameState.winner?.username || null,
                winnerDisplay: gameState.winner?.displayName || null,
                startTime: gameState.startTime ? new Date(gameState.startTime).toISOString() : null,
                endTime: new Date().toISOString(),
                durationMs: gameState.startTime ? (Date.now() - gameState.startTime) : null,
                reasonEnded: reason,
                cluesGiven: gameState.clues.length,
                gameSessionId: gameState.gameSessionId,
                roundNumber: gameState.currentRound,
                totalRounds: gameState.totalRounds,
                pointsAwarded: points,
            };
            await recordGameResult(gameDetails);
        } catch (storageError) {
            logger.error({ err: storageError }, `[GeoGame][${gameState.channelName}] Error explicitly caught from recordGameResult call for round ${gameState.currentRound}.`);
        }
    } else {
        logger.debug(`[GeoGame][${gameState.channelName}] Skipping recordGameResult call. Conditions: scoreTracking=${gameState.config.scoreTracking}, targetLocation=${!!gameState.targetLocation?.name}, reason=${reason}, validEndReason=${['guessed', 'timeout', 'stopped'].includes(reason)}`);
    }
    if (reason === "stopped" || reason === "timer_error" || reason === "location_error" || reason === "clue_error") {
        logger.info(`[GeoGame][${gameState.channelName}] Game session ended prematurely (${reason}). Reporting final scores if multi-round.`);
        if (isMultiRound && gameState.gameSessionScores.size > 0) {
            const sessionScoresMessage = formatGameSessionScoresMessage(gameState.gameSessionScores);
            enqueueMessage(`#${gameState.channelName}`, `🏁 Game ended. Final Session Scores: ${sessionScoresMessage}`);
        }
        setTimeout(() => _resetGameToIdle(gameState), MULTI_ROUND_DELAY_MS);
    } else if (isMultiRound && !isLastRound) {
        logger.info(`[GeoGame][${gameState.channelName}] Proceeding to round ${gameState.currentRound + 1}.`);
        gameState.currentRound++;
        gameState.targetLocation = null;
        gameState.startTime = null;
        gameState.clues = [];
        gameState.currentClueIndex = -1;
        gameState.guesses = [];
        gameState.winner = null;
        gameState.incorrectGuessReasons = [];
        setTimeout(() => _startNextRound(gameState), MULTI_ROUND_DELAY_MS);
    } else {
        logger.info(`[GeoGame][${gameState.channelName}] Game session finished. Reporting final results.`);
        if (isMultiRound && gameState.gameSessionScores.size > 0) {
            const sessionScoresMessage = formatGameSessionScoresMessage(gameState.gameSessionScores);
            enqueueMessage(`#${gameState.channelName}`, `🏁 Final Session Scores: ${sessionScoresMessage}`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        } else if (isMultiRound) {
            enqueueMessage(`#${gameState.channelName}`, `🏁 Game finished. No scores recorded in this session.`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (gameState.config.scoreTracking) {
            try {
                const leaderboardData = await getLeaderboard(gameState.channelName, 5);
                let leaderboardMessage = `🏆 Overall Top Players in #${gameState.channelName}: `;
                if (!leaderboardData || leaderboardData.length === 0) {
                    leaderboardMessage += `No stats yet!`;
                } else {
                    const sortedData = leaderboardData.sort((a, b) => (b.data?.channelPoints || 0) - (a.data?.channelPoints || 0));
                    const topPlayers = sortedData.slice(0, 5);
                    leaderboardMessage += topPlayers.map((p, i) => `${i + 1}. ${p.data?.displayName || p.id} (${p.data?.channelPoints || 0} pts)`).join(', ');
                }
                enqueueMessage(`#${gameState.channelName}`, leaderboardMessage);
            } catch (error) {
                logger.error({ err: error, channel: gameState.channelName }, `[GeoGame][${gameState.channelName}] Failed to fetch or format overall leaderboard.`);
                enqueueMessage(`#${gameState.channelName}`, `Could not fetch the overall channel leaderboard.`);
            }
        }
        setTimeout(() => _resetGameToIdle(gameState), MULTI_ROUND_DELAY_MS);
    }
}

// --- NEW FUNCTION: Start Next Round ---
async function _startNextRound(gameState) {
    // Should only be called when gameState.state is 'ending' after a round conclusion
    logger.info(`[GeoGame][${gameState.channelName}] Starting next round (${gameState.currentRound}/${gameState.totalRounds}).`);
    gameState.state = 'selecting'; // Transition state

    // 1. Select Location (excluding session locations and recent global locations)
    let selectedLocation = null;
    let retries = 0;
    let combinedExcludedLocations = new Set([...gameState.gameSessionExcludedLocations]); // Start with session exclusions

    try {
        // Fetch recent global locations for the channel
        const recentGlobal = await getRecentLocations(gameState.channelName, 35);
        recentGlobal.forEach(loc => combinedExcludedLocations.add(loc));
    } catch (error) {
        logger.error({ err: error, channel: gameState.channelName }, "[GeoGame] Failed to fetch recent global locations for next round, proceeding without them.");
    }
    const excludedArray = Array.from(combinedExcludedLocations);
    logger.debug(`[GeoGame][${gameState.channelName}] Round ${gameState.currentRound} exclusions: ${excludedArray.join(', ') || 'None'}`);

    // Determine game title scope and session region scope for selectLocation
    const gameTitleForSelect = gameState.mode === 'game' ? gameState.gameTitleScope : null;
    const sessionRegionForSelect = gameState.mode === 'real' ? gameState.sessionRegionScope : null;

    while (!selectedLocation && retries < MAX_LOCATION_SELECT_RETRIES) {
         if (retries > 0) {
            logger.warn(`[GeoGame][${gameState.channelName}] Retrying location selection for round ${gameState.currentRound} (Attempt ${retries + 1})...`);
            await new Promise(resolve => setTimeout(resolve, 500 * retries));
        }
        // Pass the appropriate scope to selectLocation
        const locationAttempt = await selectLocation(
            gameState.mode,
            gameState.config,
            gameTitleForSelect,
            excludedArray,
            sessionRegionForSelect // Pass session scope
        );
        if (locationAttempt?.name && !combinedExcludedLocations.has(locationAttempt.name)) {
            selectedLocation = locationAttempt;
        } else if (locationAttempt?.name) {
             logger.warn(`[GeoGame][${gameState.channelName}] selectLocation returned an excluded location ("${locationAttempt.name}") for round ${gameState.currentRound}. Retrying.`);
        } else {
             logger.warn(`[GeoGame][${gameState.channelName}] selectLocation returned null/invalid name for round ${gameState.currentRound}. Retrying.`);
        }
        retries++;
    }

    if (!selectedLocation) {
        logger.error(`[GeoGame][${gameState.channelName}] CRITICAL: Failed to select location for round ${gameState.currentRound} after retries. Ending game prematurely.`);
        enqueueMessage(`#${gameState.channelName}`, `⚠️ Error: Could not find a suitable new location for round ${gameState.currentRound}. Ending the game.`);
        // Use transitionToEnding with a specific reason to trigger cleanup/reporting
         await _transitionToEnding(gameState, "location_error"); // Pass a unique reason
        return; // Stop processing this round start
    }

    gameState.targetLocation = { name: selectedLocation.name, alternateNames: selectedLocation.alternateNames || [] };
    gameState.gameSessionExcludedLocations.add(selectedLocation.name); // Add to session exclusion list
    logger.info(`[GeoGame][${gameState.channelName}] Round ${gameState.currentRound} location selected: ${gameState.targetLocation.name}`);

    // 2. Generate Initial Clue
    // Pass the correct scope (game title for game mode, null for real mode as region is handled by selection)
    const clueScope = gameState.mode === 'game' ? gameState.gameTitleScope : null;
    const firstClue = await generateInitialClue(gameState.targetLocation.name, gameState.config.difficulty, gameState.mode, clueScope);
    if (!firstClue) {
         logger.error(`[GeoGame][${gameState.channelName}] CRITICAL: Failed to generate initial clue for round ${gameState.currentRound}. Ending game prematurely.`);
         enqueueMessage(`#${gameState.channelName}`, `⚠️ Error: Could not generate a clue for round ${gameState.currentRound}. Ending the game.`);
         await _transitionToEnding(gameState, "clue_error"); // Pass a unique reason
        return; // Stop processing
    }
    gameState.clues = [firstClue]; // Reset clues array for the new round
    gameState.currentClueIndex = 0;
    logger.info(`[GeoGame][${gameState.channelName}] Round ${gameState.currentRound} first clue generated.`);

    // 3. Start Round Timers & Send Messages
    gameState.startTime = Date.now(); // Start time for *this round*
    gameState.state = 'started'; // Mark as formally started before sending message

    // Send "Starting Round X of Y" message
    const nextRoundMessage = formatStartNextRoundMessage(gameState.currentRound, gameState.totalRounds);
    enqueueMessage(`#${gameState.channelName}`, nextRoundMessage);

    // Small delay before sending the first clue
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Check if state changed during the delay (e.g., manual stop)
    if (gameState.state !== 'started') {
        logger.warn(`[GeoGame][${gameState.channelName}] Game state changed to ${gameState.state} before first clue of round ${gameState.currentRound} could be sent. Aborting round.`);
        // If stopped, _transitionToEnding should have already been called. If not, trigger it.
        if(gameState.state !== 'ending') {
             await _transitionToEnding(gameState, "stopped_during_delay");
        }
        return; // Stop processing
    }

    const clueMessage = formatClueMessage(1, firstClue); // Clue #1 for Round 1
    enqueueMessage(`#${gameState.channelName}`, clueMessage);

    // Transition to 'inProgress' for the new round
    gameState.state = 'inProgress';
    gameState.guessCache.clear(); // Clear cache for the new round
    logger.info(`[GeoGame][${gameState.channelName}] Round ${gameState.currentRound} transitioned to inProgress.`);

    // 4. Schedule Subsequent Clues and Round End Timer (same logic as before)
    _scheduleNextClue(gameState); // Uses gameState.config.clueIntervalSeconds

    const roundDurationMs = gameState.config.roundDurationMinutes * 60 * 1000;
    logger.info(`[GeoGame][${gameState.channelName}] Round ${gameState.currentRound} end timer scheduled for ${gameState.config.roundDurationMinutes} minutes (${roundDurationMs}ms).`);

    gameState.roundEndTimer = setTimeout(async () => {
        // Timer logic remains largely the same, calling _transitionToEnding on timeout
        try {
            logger.info(`[GeoGame][${gameState.channelName}] Round ${gameState.currentRound} timer callback fired.`); // Log current round
            if (gameState.state === 'inProgress') {
                 logger.info(`[GeoGame][${gameState.channelName}] Round ${gameState.currentRound} timed out. Transitioning to ending state.`);
                 gameState.state = 'timeout'; // Mark state first
                 await _transitionToEnding(gameState, "timeout");
            } else {
                 logger.warn(`[GeoGame][${gameState.channelName}] Round ${gameState.currentRound} timer expired, but state was '${gameState.state}'. No timeout action taken.`);
            }
        } catch (error) {
             logger.error({ err: error, channel: gameState.channelName }, `[GeoGame][${gameState.channelName}] CRITICAL ERROR inside roundEndTimer callback for round ${gameState.currentRound}.`);
              if (gameState.state !== 'ending' && gameState.state !== 'idle') {
                 logger.warn(`[GeoGame][${gameState.channelName}] Attempting emergency transition to ending state after timer error in round ${gameState.currentRound}.`);
                 await _transitionToEnding(gameState, "timer_error");
             }
        }
    }, roundDurationMs);

    logger.info(`[GeoGame][${gameState.channelName}] Round ${gameState.currentRound} started successfully.`);
}


// --- Core Game Logic ---

async function _scheduleNextClue(gameState) {
    // Do NOT clear all timers here; only clear the next clue timer
    if (gameState.nextClueTimer) clearTimeout(gameState.nextClueTimer);
    gameState.nextClueTimer = null;

    // Maximum clues reached for *this round*
    if (gameState.currentClueIndex >= 4) {
        logger.info(`[GeoGame][${gameState.channelName}] Maximum clues (${gameState.currentClueIndex + 1}) reached for round ${gameState.currentRound}. Round timer will determine end.`);
        return; // Don't schedule more clues for this round
    }

    const delaySeconds = gameState.config.clueIntervalSeconds;
    // Include round number in log message
    logger.debug(`[GeoGame][${gameState.channelName}] Scheduling clue ${gameState.currentClueIndex + 2} for round ${gameState.currentRound} in ${delaySeconds} seconds.`);

    gameState.nextClueTimer = setTimeout(async () => {
        logger.debug(`[GeoGame][${gameState.channelName}] nextClueTimer fired for round ${gameState.currentRound}. State: ${gameState.state}`);
        // Check if the game state is still valid for sending a clue
        if (gameState.state !== 'inProgress') {
            logger.debug(`[GeoGame][${gameState.channelName}] Game state changed to ${gameState.state} before next clue timer fired for round ${gameState.currentRound}. Aborting clue generation.`);
            return;
        }

        // Include round number in log message
        logger.info(`[GeoGame][${gameState.channelName}] Clue timer expired, generating clue ${gameState.currentClueIndex + 2} for round ${gameState.currentRound}.`);
        try {
            // Pass incorrect guess reasons (from current round) to the clue generator
            const nextClue = await generateFollowUpClue(
                gameState.targetLocation.name,
                gameState.clues, // Clues from the *current round*
                gameState.mode,
                gameState.gameTitleScope,
                gameState.currentClueIndex + 2, // Clue number within the round
                gameState.incorrectGuessReasons // Reasons from the *current round*
            );
            if (nextClue) {
                // Check state again *after* await
                if (gameState.state !== 'inProgress') {
                    logger.debug(`[GeoGame][${gameState.channelName}] Game state changed during clue generation for round ${gameState.currentRound}. Aborting clue send.`);
                    return;
                }
                gameState.clues.push(nextClue);
                gameState.currentClueIndex++;
                 // Use currentClueIndex + 1 for the user-facing clue number
                const clueMessage = formatClueMessage(gameState.currentClueIndex + 1, nextClue);
                enqueueMessage(`#${gameState.channelName}`, clueMessage);

                // Only schedule the next clue if still in progress
                if (gameState.state === 'inProgress') {
                    logger.debug(`[GeoGame][${gameState.channelName}] Rescheduling next clue for round ${gameState.currentRound}. State: ${gameState.state}`);
                    _scheduleNextClue(gameState); // Recursive call for the same round
                } else {
                    logger.debug(`[GeoGame][${gameState.channelName}] Not rescheduling next clue for round ${gameState.currentRound}. State: ${gameState.state}`);
                }
            } else {
                logger.warn(`[GeoGame][${gameState.channelName}] Failed to generate follow-up clue ${gameState.currentClueIndex + 2} for round ${gameState.currentRound}.`);
                // Let round timer handle it.
            }
        } catch (error) {
            logger.error({ err: error }, `[GeoGame][${gameState.channelName}] Error generating or sending follow-up clue ${gameState.currentClueIndex + 2} for round ${gameState.currentRound}.`);
            // Log only.
        }
    }, delaySeconds * 1000);
}

const MAX_LOCATION_SELECT_RETRIES = 3;

// Update signature to accept generic scope
async function _startGameProcess(channelName, mode, scope = null, initiatorUsername = null, numberOfRounds = 1) {
    const gameState = await _getOrCreateGameState(channelName);

    if (gameState.state !== 'idle') {
        logger.warn(`[GeoGame][${channelName}] Attempted to start game while state is ${gameState.state}`);
        // Check if the initiator is the same as the current game's initiator and if it's multi-round
        if (gameState.initiatorUsername === initiatorUsername?.toLowerCase() && gameState.totalRounds > 1 && (gameState.state === 'inProgress' || gameState.state === 'started' || gameState.state === 'selecting')) {
             return { success: false, error: `A ${gameState.totalRounds}-round game initiated by you is already in progress (currently round ${gameState.currentRound}). Use !geo stop if needed.` };
        }
        return { success: false, error: `A game is already active or ending (${gameState.state}). Please wait or use !geo stop.` };
    }

    // Reset core game fields before starting the FIRST round
    gameState.gameSessionId = crypto.randomUUID(); // Generate new session ID
    gameState.initiatorUsername = initiatorUsername?.toLowerCase() || null; // Store initiator for the whole game
    gameState.mode = mode;
    // Set scope based on mode
    gameState.gameTitleScope = mode === 'game' ? scope : null;
    gameState.sessionRegionScope = mode === 'real' ? scope : null; // Store user-provided region scope
    gameState.state = 'selecting'; // Initial state during setup
    gameState.targetLocation = null;
    gameState.startTime = null;
    gameState.clues = [];
    gameState.currentClueIndex = -1;
    gameState.guesses = [];
    gameState.winner = null;
    gameState.incorrectGuessReasons = [];
    // --- Initialize Multi-Round State ---
    gameState.totalRounds = Math.max(1, numberOfRounds); // Ensure at least 1 round
    gameState.currentRound = 1;
    gameState.streakMap = new Map();
    gameState.gameSessionScores = new Map();
    gameState.guessCache = new Map();
    gameState.gameSessionExcludedLocations = new Set(); // Reset for the new game session
    _clearTimers(gameState); // Ensure no stray timers

    const scopeLog = scope ? (mode === 'game' ? `Game Scope: ${scope}` : `Region Scope: ${scope}`) : 'Scope: N/A';
    logger.info(`[GeoGame][${channelName}] Starting new game process. Mode: ${mode}, ${scopeLog}, Rounds: ${gameState.totalRounds}, Initiator: ${gameState.initiatorUsername}`);

    // --- Send Game Start Announcement Immediately ---
    const startMessage = formatStartMessage(mode, gameState.gameTitleScope, gameState.config.roundDurationMinutes, gameState.totalRounds, gameState.sessionRegionScope);
    enqueueMessage(`#${channelName}`, startMessage);

    try {
        // --- Location Selection for Round 1 ---
        let selectedLocation = null;
        let retries = 0;
        let excludedLocations = []; // For the first round, just use global recent
        try {
            logger.debug(`[GeoGame][${channelName}] Fetching recent locations...`);
            excludedLocations = await getRecentLocations(channelName, 35);
        } catch (error) {
            logger.error({ err: error, channel: channelName }, "[GeoGame] Failed to fetch recent locations for Round 1, proceeding with no exclusions.");
        }
        logger.debug(`[GeoGame][${channelName}] Round 1 Locations to exclude: ${excludedLocations.join(', ')}`);

        // Determine scopes for selectLocation call
        const gameTitleForSelect = gameState.mode === 'game' ? gameState.gameTitleScope : null;
        const sessionRegionForSelect = gameState.mode === 'real' ? gameState.sessionRegionScope : null;

        while (!selectedLocation && retries < MAX_LOCATION_SELECT_RETRIES) {
            if (retries > 0) {
                logger.warn(`[GeoGame][${channelName}] Retrying location selection for Round 1 (Attempt ${retries + 1})...`);
                await new Promise(resolve => setTimeout(resolve, 500 * retries));
            }
            // Pass the appropriate scope to selectLocation
            const locationAttempt = await selectLocation(
                mode,
                gameState.config,
                gameTitleForSelect,
                excludedLocations,
                sessionRegionForSelect // Pass session scope
            );
            if (locationAttempt?.name && !excludedLocations.includes(locationAttempt.name)) {
                selectedLocation = locationAttempt;
            } else if (locationAttempt?.name) {
                logger.warn(`[GeoGame][${channelName}] selectLocation returned an excluded location ("${locationAttempt.name}") for Round 1. Retrying.`);
            } else {
                logger.warn(`[GeoGame][${channelName}] selectLocation returned null or invalid name for Round 1. Retrying.`);
            }
            retries++;
        }
        if (!selectedLocation) {
            throw new Error(`Failed to select a valid, non-repeated location for Round 1 after ${MAX_LOCATION_SELECT_RETRIES} attempts.`);
        }
        gameState.targetLocation = { name: selectedLocation.name, alternateNames: selectedLocation.alternateNames || [] };
        gameState.gameSessionExcludedLocations.add(selectedLocation.name); // Add to session exclusion set
        logger.info(`[GeoGame][${channelName}] Round 1 Location selected: ${gameState.targetLocation.name}`);

        // 2. Generate Initial Clue (Round 1)
        // Pass game title only if game mode
        const clueScope = mode === 'game' ? gameState.gameTitleScope : null;
        const firstClue = await generateInitialClue(gameState.targetLocation.name, gameState.config.difficulty, mode, clueScope);
        if (!firstClue) {
            throw new Error("Failed to generate the initial clue for Round 1.");
        }
        gameState.clues.push(firstClue);
        gameState.currentClueIndex = 0;
        logger.info(`[GeoGame][${channelName}] Round 1 First clue generated.`);

        // 3. Start Game Timers & Send First Clue (Round 1)
        gameState.startTime = Date.now(); // Start time for Round 1
        gameState.state = 'started'; // Mark as formally started

        // Check if state changed during location/clue generation
        if (gameState.state !== 'started') {
            logger.warn(`[GeoGame][${channelName}] Game state changed to ${gameState.state} before first clue of Round 1 could be sent. Aborting start.`);
             if(gameState.state !== 'ending') {
                 // If not already ending (e.g., by stop command), reset fully
                 await _resetGameToIdle(gameState); // Use await for async reset
             }
            return { success: false, error: "Game was stopped before the first clue." };
        }

        const clueMessage = formatClueMessage(1, firstClue); // Clue #1 for Round 1
        enqueueMessage(`#${channelName}`, clueMessage);

        // Transition to 'inProgress'
        gameState.state = 'inProgress';
        gameState.guessCache.clear(); // Clear cache for the new round
        logger.info(`[GeoGame][${channelName}] Game (Round 1) transitioned to inProgress.`);

        // 4. Schedule Subsequent Clues and Round End Timer (Round 1)
        _scheduleNextClue(gameState); // Schedules clues for the current round

        const roundDurationMs = gameState.config.roundDurationMinutes * 60 * 1000;
        logger.info(`[GeoGame][${channelName}] Round 1 end timer scheduled for ${gameState.config.roundDurationMinutes} minutes (${roundDurationMs}ms).`);

        gameState.roundEndTimer = setTimeout(async () => {
             // --- Round End Timer Logic (Same structure, calls _transitionToEnding) ---
            try {
                logger.info(`[GeoGame][${gameState.channelName}] Round ${gameState.currentRound} timer callback fired.`); // Log current round
                if (gameState.state === 'inProgress') {
                    logger.info(`[GeoGame][${gameState.channelName}] Round ${gameState.currentRound} timed out. Transitioning to ending state.`);
                    gameState.state = 'timeout'; // Mark state first
                    await _transitionToEnding(gameState, "timeout");
                } else {
                    logger.warn(`[GeoGame][${gameState.channelName}] Round ${gameState.currentRound} timer expired, but state was '${gameState.state}'. No timeout action taken.`);
                }
            } catch (error) {
                 logger.error({ err: error, channel: gameState.channelName }, `[GeoGame][${gameState.channelName}] CRITICAL ERROR inside roundEndTimer callback for round ${gameState.currentRound}.`);
                  if (gameState.state !== 'ending' && gameState.state !== 'idle') {
                     logger.warn(`[GeoGame][${gameState.channelName}] Attempting emergency transition to ending state after timer error in round ${gameState.currentRound}.`);
                     await _transitionToEnding(gameState, "timer_error");
                 }
            }
        }, roundDurationMs);

        logger.info(`[GeoGame][${channelName}] Game started successfully (Round 1/${gameState.totalRounds}). Target: ${gameState.targetLocation.name}. First clue sent.`);
        return { success: true, message: "" }; // Success, no direct user message needed here

    } catch (error) {
        logger.error({ err: error }, `[GeoGame][${channelName}] Critical error during game start process (Round 1).`);
        // Ensure state is reset cleanly on critical failure during startup
        await _resetGameToIdle(gameState); // Use await for async reset
        const userError = error.message.includes("Failed to select") || error.message.includes("Failed to generate")
            ? `Error starting game: ${error.message}`
            : "An unexpected error occurred while starting the game. Please try again later.";
        return { success: false, error: userError };
    }
}


async function _handleGuess(channelName, username, displayName, guess) {
    const gameState = activeGames.get(channelName);

    if (!gameState || gameState.state !== 'inProgress') {
        return;
    }

    const now = Date.now();
    if (now - gameState.lastMessageTimestamp < 1000) {
        return;
    }
    gameState.lastMessageTimestamp = now;

    const trimmedGuess = guess.trim();
    if (!trimmedGuess) return;

    // Check the cache for this normalized guess first
    const normalizedGuess = trimmedGuess.toLowerCase().trim();
    if (gameState.guessCache.has(normalizedGuess)) {
        logger.debug(`[GeoGame][${channelName}] Guess "${trimmedGuess}" found in incorrect guess cache. Skipping LLM verification.`);
        return; // It's a known wrong guess for this round, do nothing.
    }

    logger.debug(`[GeoGame][${channelName}] Processing guess for round ${gameState.currentRound}: "${trimmedGuess}" from ${username}`);
    gameState.guesses.push({ username, displayName, guess: trimmedGuess, timestamp: new Date(), round: gameState.currentRound });

    // Added: Translate user's guess if botlang is set
    const contextManager = getContextManager();
    const botLanguage = contextManager.getBotLanguage(channelName);
    let guessToVerify = trimmedGuess;

    if (botLanguage && botLanguage.toLowerCase() !== 'english' && botLanguage.toLowerCase() !== 'en') {
        logger.debug(`[GeoGame][${channelName}] Bot language is ${botLanguage}. Translating user guess "${trimmedGuess}" to English for verification.`);
        try {
            const translatedUserGuess = await translateText(trimmedGuess, 'English');
            if (translatedUserGuess && translatedUserGuess.trim().length > 0) {
                guessToVerify = translatedUserGuess.trim();
                logger.info(`[GeoGame][${channelName}] Translated user guess for verification: "${trimmedGuess}" -> "${guessToVerify}"`);
            } else {
                logger.warn(`[GeoGame][${channelName}] Translation of guess "${trimmedGuess}" to English resulted in empty string. Using original for verification.`);
            }
        } catch (translateError) {
            logger.error({ err: translateError, channelName, trimmedGuess, botLanguage }, `[GeoGame][${channelName}] Failed to translate user guess to English for verification. Using original.`);
        }
    }
    // End of added translation logic

    try {
        const validationResult = await validateGuess(gameState.targetLocation.name, guessToVerify, gameState.targetLocation.alternateNames);

        if (gameState.state !== 'inProgress') {
            logger.debug(`[GeoGame][${channelName}] Game state changed to ${gameState.state} while validating guess from ${username} for round ${gameState.currentRound}. Ignoring result.`);
            return;
        }

        if (validationResult && validationResult.is_correct) {
            logger.info(`[GeoGame][${channelName}] Correct guess for round ${gameState.currentRound} "${trimmedGuess}" (verified as "${guessToVerify}") by ${username}. Confidence: ${validationResult.confidence || 'N/A'}`);
            gameState.winner = { username, displayName };
            gameState.state = 'guessed';

            const timeTakenMs = Date.now() - gameState.startTime;
            _transitionToEnding(gameState, "guessed", timeTakenMs);
        } else {
            // Cache the incorrect guess to prevent re-verification
            gameState.guessCache.set(normalizedGuess, {
                result: validationResult,
                timestamp: Date.now()
            });
            logger.debug(`[GeoGame][${channelName}] Caching incorrect guess: "${trimmedGuess}"`);

            const reason = validationResult?.reasoning?.trim();
            if (reason) {
                 if (!gameState.incorrectGuessReasons.includes(reason)) {
                    gameState.incorrectGuessReasons.push(reason);
                    if (gameState.incorrectGuessReasons.length > 5) {
                        gameState.incorrectGuessReasons.shift();
                    }
                    logger.debug(`[GeoGame][${channelName}] Stored incorrect guess reason for round ${gameState.currentRound}: "${reason}".`);
                 }
            }
        }
    } catch (error) {
        logger.error({ err: error }, `[GeoGame][${channelName}] Error validating guess "${trimmedGuess}" (verified as "${guessToVerify}") from ${username} for round ${gameState.currentRound}.`);
    }
}


// --- Public Interface ---

/**
 * Initializes the GeoGame Manager.
 */
async function initializeGeoGameManager() {
    logger.info("Initializing GeoGame Manager...");
    activeGames.clear(); // Clean slate
    logger.info("GeoGame Manager initialized successfully.");
}

/**
 * Starts a new game session (potentially multi-round) in the specified channel.
 * Calls the internal _startGameProcess and returns its result.
 * @param {string} channelName - Channel name (without #).
 * @param {'real' | 'game'} mode - Game mode.
 * @param {string | null} [scope=null] - Specific game title for 'game' mode OR region scope for 'real' mode.
 * @param {string | null} [initiatorUsername=null] - Lowercase username of the game initiator.
 * @param {number} [numberOfRounds=1] - Number of rounds for the game session.
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
async function startGame(channelName, mode, scope = null, initiatorUsername = null, numberOfRounds = 1) {
    // Directly call the internal process function with the generic scope and number of rounds
    return await _startGameProcess(channelName, mode, scope, initiatorUsername, numberOfRounds);
}

/**
 * Stops the currently active game session (single or multi-round) in a channel.
 * @param {string} channelName - Channel name (without #).
 * @returns {{message: string}} Result message for the command issuer.
 */
function stopGame(channelName) {
    const gameState = activeGames.get(channelName);

    // Check if there's a game in a stoppable state
     if (!gameState || gameState.state === 'idle' || gameState.state === 'ending') {
        const stateMsg = gameState ? `(state: ${gameState.state})` : '(no game active)';
        logger.debug(`[GeoGame][${channelName}] Stop command received, but no stoppable game found ${stateMsg}.`);
        return { message: "No active Geo-Game round/session to stop in this channel." };
    }

    logger.info(`[GeoGame][${channelName}] Stop command received during round ${gameState.currentRound}/${gameState.totalRounds}. Manually ending game session from state: ${gameState.state}.`);

    // Transition to the ending sequence with "stopped" reason.
    // _transitionToEnding will handle reporting scores (if multi-round) and resetting.
    _transitionToEnding(gameState, "stopped");

    return { message: "Geo-Game stopped successfully. Final results (if any) are being reported." };
}

/**
 * Processes a chat message to check if it's a potential guess for an active game round.
 * Delegates the actual handling and validation to _handleGuess.
 * @param {string} channelName - Channel name (without #).
 * @param {string} username - User's lowercase username.
 * @param {string} displayName - User's display name.
 * @param {string} message - The chat message text.
 */
function processPotentialGuess(channelName, username, displayName, message) {
    const gameState = activeGames.get(channelName);
    // Check if game is 'inProgress' (meaning a round is active) and not a command
    if (gameState && gameState.state === 'inProgress' && !message.startsWith('!')) {
        _handleGuess(channelName, username, displayName, message.trim()).catch(err => {
             logger.error({ err, channel: channelName, user: username }, `[GeoGame][${channelName}] Unhandled error processing potential guess for round ${gameState.currentRound}.`);
        });
    }
}


/**
 * Configures game settings for a channel. (Currently Placeholder)
 * @param {string} channelName - Channel to configure.
 * @param {object} options - Key-value pairs of settings to update.
 * @returns {{message: string}} Result message.
 */
async function configureGame(channelName, options) {
    const gameState = await _getOrCreateGameState(channelName);
    logger.info(`[GeoGame][${channelName}] Configure command received with options: ${JSON.stringify(options)}`);
    let changesMade = [];
    let configChanged = false;

    // Example: Update difficulty
    if (options.difficulty && ['easy', 'normal', 'hard'].includes(options.difficulty)) {
        if (gameState.config.difficulty !== options.difficulty) {
            gameState.config.difficulty = options.difficulty;
            changesMade.push(`Difficulty set to ${options.difficulty}`);
            configChanged = true;
        }
    }

    // Example: Update clue interval
    if (options.clueIntervalSeconds) {
        const interval = parseInt(options.clueIntervalSeconds, 10);
        if (!isNaN(interval) && interval >= 30 && interval <= 300) {
            if (gameState.config.clueIntervalSeconds !== interval) {
                gameState.config.clueIntervalSeconds = interval;
                changesMade.push(`Clue interval set to ${interval} seconds`);
                configChanged = true;
            }
        } else {
             changesMade.push(`Invalid clue interval "${options.clueIntervalSeconds}". Must be between 30 and 300.`);
        }
    }

    // Example: Update round duration
     if (options.roundDurationMinutes) {
        const duration = parseInt(options.roundDurationMinutes, 10);
        if (!isNaN(duration) && duration >= 3 && duration <= 20) { // Example range 3-20 mins
            if (gameState.config.roundDurationMinutes !== duration) {
                gameState.config.roundDurationMinutes = duration;
                changesMade.push(`Round duration set to ${duration} minutes`);
                configChanged = true;
            }
        } else {
             changesMade.push(`Invalid round duration "${options.roundDurationMinutes}". Must be between 3 and 20 minutes.`);
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

    // Region restrictions
    if (options.regionRestrictions) {
        // Ensure it's an array
        const regions = Array.isArray(options.regionRestrictions) ? options.regionRestrictions : String(options.regionRestrictions).split(',').map(s => s.trim()).filter(Boolean);
        gameState.config.regionRestrictions = regions;
        changesMade.push(`Region restrictions updated to: ${regions.join(', ') || 'None'}`);
        configChanged = true;
    }

    // Game title preferences (similar handling as regions)
    if (options.gameTitlePreferences) {
         const titles = Array.isArray(options.gameTitlePreferences) ? options.gameTitlePreferences : String(options.gameTitlePreferences).split(',').map(s => s.trim()).filter(Boolean);
        gameState.config.gameTitlePreferences = titles;
        changesMade.push(`Game title preferences updated to: ${titles.join(', ') || 'None'}`);
        configChanged = true;
    }

    // --- Add handling for new scoring options ---
    if (options.pointsBase !== undefined) {
        const points = parseInt(options.pointsBase, 10);
        if (!isNaN(points) && points >= 1 && points <= 100) {
            if (gameState.config.pointsBase !== points) {
                gameState.config.pointsBase = points;
                changesMade.push(`Base points set to ${points}`);
                configChanged = true;
            }
        } else {
            changesMade.push(`Invalid base points "${options.pointsBase}". Must be between 1 and 100.`);
        }
    }
    if (options.pointsTimeBonus !== undefined) {
        const enableTimeBonus = options.pointsTimeBonus === 'true' || options.pointsTimeBonus === true;
        if (gameState.config.pointsTimeBonus !== enableTimeBonus) {
            gameState.config.pointsTimeBonus = enableTimeBonus;
            changesMade.push(`Time bonus scoring ${enableTimeBonus ? 'enabled' : 'disabled'}`);
            configChanged = true;
        }
    }
    if (options.pointsDifficultyMultiplier !== undefined) {
        const enableMultiplier = options.pointsDifficultyMultiplier === 'true' || options.pointsDifficultyMultiplier === true;
        if (gameState.config.pointsDifficultyMultiplier !== enableMultiplier) {
            gameState.config.pointsDifficultyMultiplier = enableMultiplier;
            changesMade.push(`Difficulty multiplier scoring ${enableMultiplier ? 'enabled' : 'disabled'}`);
            configChanged = true;
        }
    }

    if (configChanged) {
        try {
            await saveChannelConfig(channelName, gameState.config);
            logger.info(`[GeoGame][${channelName}] Configuration updated and saved: ${changesMade.join(', ')}`);
            return { message: `Geo-Game settings updated: ${changesMade.join('. ')}.` };
        } catch (error) {
            logger.error({ err: error, channel: channelName }, `[GeoGame][${channelName}] Failed to save configuration changes.`);
            return { message: `Settings updated in memory, but failed to save them permanently.` };
        }
    } else if (changesMade.length > 0 && !configChanged) {
        // Changes were attempted but values were invalid or same as current
        return { message: `Geo-Game settings not changed: ${changesMade.join('. ')}.` };
    } else {
        return { message: "No valid configuration options provided or settings are already up-to-date. Use !geo help config for options." };
    }
}

/**
 * Resets the configuration for a channel back to the default settings.
 * @param {string} channelName - Channel name (without #).
 * @returns {Promise<{success: boolean, message: string}>} Result object.
 */
async function resetChannelConfig(channelName) {
    const gameState = await _getOrCreateGameState(channelName);
    logger.info(`[GeoGame][${channelName}] Resetting configuration to defaults.`);
    try {
        const newConfig = { ...DEFAULT_CONFIG };
        gameState.config = newConfig;
        await saveChannelConfig(channelName, gameState.config);
        logger.info(`[GeoGame][${channelName}] Configuration successfully reset and saved.`);
        return { success: true, message: "Geo-Game configuration reset to defaults." };
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `[GeoGame][${channelName}] Failed to save reset configuration.`);
        return { success: false, message: "Configuration reset in memory, but failed to save permanently. Please try again." };
    }
}

function getCurrentGameInitiator(channelName) {
    const gameState = activeGames.get(channelName);
     // Check any active state, including selecting/started for multi-round checks
    if (gameState && gameState.state !== 'idle') {
        return gameState.initiatorUsername;
    }
    return null;
}

/**
 * Clears the leaderboard data for the specified channel.
 * Calls the storage layer function to perform the operation.
 * @param {string} channelName - Channel name (without #).
 * @returns {Promise<{success: boolean, message: string}>} Result object.
 */
async function clearLeaderboard(channelName) {
    logger.info(`[GeoGame][${channelName}] Received request to clear leaderboard data.`);
    try {
        const result = await clearChannelLeaderboardData(channelName.toLowerCase());
        logger.info(`[GeoGame][${channelName}] Leaderboard clear result: ${result.message}`);
        return { success: result.success, message: result.message };
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `[GeoGame][${channelName}] Unexpected error calling clearChannelLeaderboardData.`);
        const errorMessage = error.message || 'An unexpected error occurred while trying to clear the leaderboard.';
        return { success: false, message: errorMessage };
    }
}

/**
 * Gets the name of the last location played in the channel.
 * @param {string} channelName - Channel name (without #).
 * @returns {string | null} The name of the last location, or null if none recorded.
 */
function getLastPlayedLocation(channelName) {
    const gameState = activeGames.get(channelName);
    return gameState?.lastPlayedLocation || null;
}

/**
 * Initiates the process for reporting a problematic Geo-Game location.
 * If the last game was multi-round, it prompts the user for a round number.
 * Otherwise, it reports the last played location directly.
 * @param {string} channelName - Channel name (without #).
 * @param {string} reason - Reason for reporting.
 * @param {string} reportedByUsername - Username of the reporter (lowercase).
 * @returns {Promise<{success: boolean, message: string, needsFollowUp?: boolean}>}
 */
async function initiateReportProcess(channelName, reason, reportedByUsername) {
    logger.info(`[GeoGameManager][${channelName}] Initiating report process. Reason: "${reason}", By: ${reportedByUsername}`);
    const sessionInfo = await getLatestGeoSession(channelName);

    if (!sessionInfo || !sessionInfo.itemsInSession || sessionInfo.itemsInSession.length === 0) {
        logger.warn(`[GeoGameManager][${channelName}] No session info found for reporting.`);
        return { success: false, message: "I couldn't find a recently played Geo-Game round in this channel to report." };
    }

    const { totalRounds, itemsInSession } = sessionInfo;
    const reportedByDisplayName = reportedByUsername;

    if (totalRounds > 1 && itemsInSession.length > 0) {
        const reportKey = `${channelName}_${reportedByUsername.toLowerCase()}`;
        pendingGeoReports.set(reportKey, {
            reason,
            itemsInSession,
            reportedByUsername,
            expiresAt: Date.now() + PENDING_GEO_REPORT_TIMEOUT_MS
        });
        setTimeout(() => {
            if (pendingGeoReports.has(reportKey) && pendingGeoReports.get(reportKey).expiresAt <= Date.now()) {
                pendingGeoReports.delete(reportKey);
                logger.info(`[GeoGameManager][${channelName}] Expired pending geo report for ${reportKey}`);
            }
        }, PENDING_GEO_REPORT_TIMEOUT_MS + 1000);
        const maxRoundFound = itemsInSession.reduce((max, item) => Math.max(max, item.roundNumber), 0);
        let promptMessage = `@${reportedByDisplayName}, the last Geo-Game had ${totalRounds} round(s).`;
        if (itemsInSession.length < totalRounds && itemsInSession.length > 0) {
            promptMessage = `@${reportedByDisplayName}, I found ${itemsInSession.length} location(s) from the last session (expected ${totalRounds}).`;
        }
        promptMessage += ` Which round's location (1-${maxRoundFound}) are you reporting? Reply with just the number.`;
        return { success: true, message: promptMessage, needsFollowUp: true };
    } else if (itemsInSession.length === 1) {
        const itemToReport = itemsInSession[0];
        if (!itemToReport || !itemToReport.docId) {
            logger.warn(`[GeoGameManager][${channelName}] Single item session, but docId missing for report.`);
            return { success: false, message: "Could not identify a specific location to report from the last game." };
        }
        try {
            const directReportResult = await reportProblemLocation(itemToReport.itemData, reason, channelName, reportedByUsername);
            logger.info(`[GeoGameManager][${channelName}] Successfully reported single/latest location: "${itemToReport.itemData}"`);
            return { success: directReportResult.success, message: directReportResult.message };
        } catch (error) {
            logger.error({ err: error, channelName }, `[GeoGameManager][${channelName}] Error reporting location directly.`);
            return { success: false, message: "Sorry, an error occurred while trying to report the location." };
        }
    } else {
        logger.warn(`[GeoGameManager][${channelName}] No items found in session for reporting, though sessionInfo was present.`);
        return { success: false, message: "No specific locations found in the last game session to report." };
    }
}

/**
 * Finalizes a report for a Geo-Game location based on the user-provided round number.
 * @param {string} channelName - Channel name (without #).
 * @param {string} username - Username of the user responding (lowercase).
 * @param {string} roundNumberStr - The numeric string provided by the user.
 * @returns {Promise<{success: boolean, message: string | null}>}
 * message is null if no pending report or if it's an internal error not messaged to user.
 * message is a string to be sent to the user otherwise.
 */
async function finalizeReportWithRoundNumber(channelName, username, roundNumberStr) {
    const reportKey = `${channelName}_${username.toLowerCase()}`;
    const pendingData = pendingGeoReports.get(reportKey);

    if (!pendingData) {
        return { success: false, message: null }; // No pending report for this user
    }

    if (pendingData.expiresAt <= Date.now()) {
        pendingGeoReports.delete(reportKey);
        logger.info(`[GeoGameManager][${channelName}] Attempt to finalize an expired geo report by ${username}.`);
        return { success: true, message: `@${username}, your report session timed out. Please use !geo report again.` };
    }

    const roundNum = parseInt(roundNumberStr, 10);
    // Validate against the actual round numbers available in itemsInSession
    const itemToReport = pendingData.itemsInSession.find(item => item.roundNumber === roundNum);

    if (isNaN(roundNum) || !itemToReport) {
        // Don't delete pendingData here, let them try again if they mistyped, until timeout.
        const maxRound = pendingData.itemsInSession.reduce((max, item) => Math.max(max, item.roundNumber), 0);
        return { success: true, message: `@${username}, that's not a valid round number (1-${maxRound}) from the last game session. Please reply with a valid number or try reporting again.` };
    }

    if (!itemToReport.docId) {
        pendingGeoReports.delete(reportKey); // Clean up
        logger.error(`[GeoGameManager][${channelName}] Found item for round ${roundNum} but it's missing a docId.`);
        return { success: true, message: `@${username}, I found round ${roundNum}, but there was an issue identifying it for the report. Please try again.` };
    }

    try {
        await flagGeoLocationByDocId(itemToReport.docId, pendingData.reason, pendingData.reportedByUsername);
        pendingGeoReports.delete(reportKey); // Clean up successful report
        logger.info(`[GeoGameManager][${channelName}] Successfully finalized report for geo round ${roundNum}, doc ID ${itemToReport.docId}, Location: "${itemToReport.itemData}"`);
        return { success: true, message: `@${username}, thanks! Your report for the location from round ${roundNum} ("${String(itemToReport.itemData).substring(0, 30)}...") has been submitted.` };
    } catch (error) {
        // Don't delete pending data on error, user might want to know it failed to save
        logger.error({ err: error, channelName }, `[GeoGameManager][${channelName}] Error finalizing report for geo round ${roundNum}.`);
        return { success: true, message: `@${username}, an error occurred submitting your report for round ${roundNum}. Please try again or contact a mod.` };
    }
}

/**
 * Gets the singleton GeoGame Manager instance/interface.
 */
function getGeoGameManager() {
    // Expose public methods
    return {
        initialize: initializeGeoGameManager,
        startGame, // Updated signature is handled internally
        stopGame,
        processPotentialGuess,
        configureGame,
        resetChannelConfig,
        getCurrentGameInitiator,
        clearLeaderboard,
        getLastPlayedLocation,
        initiateReportProcess,
        finalizeReportWithRoundNumber
    };
}

export { initializeGeoGameManager, getGeoGameManager };

/**
 * Calculates points for a correct guess based on game config.
 * @param {GameState} gameState - Game state object.
 * @param {number} timeElapsedMs - Time elapsed in milliseconds.
 * @returns {number} Points earned.
 */
function _calculatePoints(gameState, timeElapsedMs) {
    if (!gameState.config.scoreTracking) return 0;
    let points = gameState.config.pointsBase ?? DEFAULT_CONFIG.pointsBase;
    if (gameState.config.pointsDifficultyMultiplier) {
        switch ((gameState.config.difficulty || 'normal').toLowerCase()) {
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
    if (gameState.config.pointsTimeBonus) {
        const totalTimeSeconds = (gameState.config.roundDurationMinutes ?? DEFAULT_CONFIG.roundDurationMinutes) * 60;
        const totalTimeMs = totalTimeSeconds * 1000;
        if (totalTimeMs > 0) {
            const timeRemainingRatio = Math.max(0, (totalTimeMs - timeElapsedMs) / totalTimeMs);
            const timeBonus = Math.floor((gameState.config.pointsBase ?? DEFAULT_CONFIG.pointsBase) * 0.5 * timeRemainingRatio);
            points += timeBonus;
        }
    }
    const winnerUsername = gameState.winner?.username;
    if (winnerUsername) {
        const currentStreak = gameState.streakMap.get(winnerUsername) || 0;
        if (currentStreak > 0) {
            const streakMultiplier = 1 + (currentStreak * 0.1);
            points = Math.floor(points * streakMultiplier);
            logger.debug(`[GeoGame][${gameState.channelName}] Applying streak bonus x${streakMultiplier.toFixed(1)} for ${winnerUsername} (Streak: ${currentStreak + 1})`);
        }
    }
    return Math.max(1, Math.floor(points));
}