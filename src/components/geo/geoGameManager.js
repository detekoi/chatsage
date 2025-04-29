import logger from '../../lib/logger.js';
import { enqueueMessage } from '../../lib/ircSender.js';
import { selectLocation, validateGuess } from './geoLocationService.js';
import { generateInitialClue, generateFollowUpClue, generateFinalReveal } from './geoClueService.js';
import { formatStartMessage, formatClueMessage, formatCorrectGuessMessage, formatTimeoutMessage, formatStopMessage, formatRevealMessage, formatStartNextRoundMessage, formatGameSessionScoresMessage } from './geoMessageFormatter.js';
import { loadChannelConfig, saveChannelConfig, recordGameResult, updatePlayerScore, getRecentLocations, getLeaderboard, clearChannelLeaderboardData } from './geoStorage.js';
import { summarizeText } from '../llm/geminiClient.js';

// --- Game State & Config Interfaces (Conceptual) ---
/*
interface GameConfig {
    difficulty: 'easy' | 'normal' | 'hard';
    clueIntervalSeconds: number; // 30-300
    roundDurationMinutes: number; // 5-15
    scoreTracking: boolean;
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

    // --- Multi-Round Fields ---
    totalRounds: number; // Total number of rounds requested
    currentRound: number; // Current round number (1-based)
    gameSessionScores: Map<string, { displayName: string; score: number }>; // username -> { displayName, score } for the current multi-round game
    gameSessionExcludedLocations: Set<string>; // Locations used in the current multi-round session
}
*/

// --- Default Configuration ---
const DEFAULT_CONFIG = {
    difficulty: 'normal',
    clueIntervalSeconds: 60,
    roundDurationMinutes: 5,
    scoreTracking: true,
    regionRestrictions: [],
    gameTitlePreferences: [],
};

const MAX_IRC_MESSAGE_LENGTH = 450; // Should match ircSender.js
const SUMMARY_TARGET_LENGTH = 400; // Slightly less than max to allow for prefixes
const MULTI_ROUND_DELAY_MS = 5000; // Delay between rounds

// --- In-Memory Storage for Active Games ---
/** @type {Map<string, GameState>} */
const activeGames = new Map(); // channelName -> GameState

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
        if (!loadedConfig) {
            logger.info(`[GeoGame][${channelName}] No saved config found, using default.`);
            loadedConfig = { ...DEFAULT_CONFIG };
            try {
                await saveChannelConfig(channelName, loadedConfig);
            } catch (error) {
                logger.error({ err: error, channel: channelName }, "[GeoGame] Failed to save default config to storage.");
            }
        } else {
            logger.info(`[GeoGame][${channelName}] Loaded saved config.`);
            loadedConfig = { ...DEFAULT_CONFIG, ...loadedConfig };
        }
        activeGames.set(channelName, {
            channelName,
            mode: 'real', // Default mode
            state: 'idle',
            targetLocation: null,
            gameTitleScope: null,
            sessionRegionScope: null, // Initialize new field
            startTime: null, // Start time of the *current round*
            clues: [],
            currentClueIndex: -1,
            nextClueTimer: null,
            roundEndTimer: null,
            guesses: [],
            winner: null, // Winner of the *current round*
            initiatorUsername: null,
            config: loadedConfig,
            lastMessageTimestamp: 0,
            incorrectGuessReasons: [],
            // Multi-Round Fields
            totalRounds: 1,
            currentRound: 1,
            gameSessionScores: new Map(),
            gameSessionExcludedLocations: new Set(), // Initialize exclusion set
        });
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
    const config = gameState.config; // Preserve config
    // Use _getOrCreateGameState to get a fresh structure, then overwrite with persisted config
    const newState = await _getOrCreateGameState(gameState.channelName); // Gets initial structure & sets it in map
    newState.config = config; // Restore preserved config
    newState.state = 'idle'; // Ensure it's explicitly idle
    // Explicitly clear game-specific data
    newState.targetLocation = null;
    newState.gameTitleScope = null; // Clear game scope
    newState.sessionRegionScope = null; // Clear session region scope
    newState.startTime = null;
    newState.clues = [];
    newState.currentClueIndex = -1;
    newState.guesses = [];
    newState.winner = null; // Clear round winner
    newState.incorrectGuessReasons = [];
    newState.initiatorUsername = null; // Clear initiator for the next game
    // Reset multi-round fields
    newState.totalRounds = 1;
    newState.currentRound = 1;
    newState.gameSessionScores = new Map();
    newState.gameSessionExcludedLocations = new Set();
}

async function _transitionToEnding(gameState, reason = "guessed", timeTakenMs = null) {
    _clearTimers(gameState);

    // If already ending/idle, do nothing further to prevent loops/errors
    if (gameState.state === 'ending' || gameState.state === 'idle') {
        logger.warn(`[GeoGame][${gameState.channelName}] Game state is already '${gameState.state}'. Ignoring transition request (Reason: ${reason}).`);
        return;
    }

    const previousState = gameState.state; // Record previous state for logic
    gameState.state = 'ending'; // Set state to ending to prevent other actions
    logger.info(`[GeoGame][${gameState.channelName}] Round ${gameState.currentRound}/${gameState.totalRounds} ending. Reason: ${reason}`);

    const isMultiRound = gameState.totalRounds > 1;
    const isLastRound = gameState.currentRound === gameState.totalRounds;

    // --- 1. Handle Scoring (Both Session and Persistent) ---
    if (reason === "guessed" && gameState.winner?.username) {
        const winnerUsername = gameState.winner.username;
        const winnerDisplayName = gameState.winner.displayName;

        // a) Update Multi-Round Session Score
        if (isMultiRound) {
            const currentSessionScore = gameState.gameSessionScores.get(winnerUsername)?.score || 0;
            gameState.gameSessionScores.set(winnerUsername, {
                displayName: winnerDisplayName,
                score: currentSessionScore + 1
            });
            logger.debug(`[GeoGame][${gameState.channelName}] Updated session score for ${winnerUsername}: ${currentSessionScore + 1}`);
        }

        // b) Update Persistent Score (if enabled)
        if (gameState.config.scoreTracking) {
            try {
                logger.debug(`[GeoGame][${gameState.channelName}] Calling updatePlayerScore for ${winnerUsername}.`);
                await updatePlayerScore(winnerUsername, gameState.channelName, 1, winnerDisplayName);
                logger.debug(`[GeoGame][${gameState.channelName}] Successfully awaited updatePlayerScore for ${winnerUsername}.`);
            } catch(scoreError) {
                logger.error({ err: scoreError }, `[GeoGame][${gameState.channelName}] Error explicitly caught from updatePlayerScore call.`);
                // Continue to record history even if score update fails
            }
        }
    }

    // --- 2. Generate and Send Round Reveal Message ---
    let revealText = null;
    let roundEndMessage = "";

    if (!gameState.targetLocation?.name) {
        logger.error(`[GeoGame][${gameState.channelName}] Cannot generate round reveal: targetLocation is missing.`);
        roundEndMessage = "An error occurred, and the round's location couldn't be revealed.";
    } else {
        try {
            revealText = await generateFinalReveal(gameState.targetLocation.name, gameState.mode, gameState.gameTitleScope, reason);
            logger.debug(`[GeoGame][${gameState.channelName}] Round reveal text generated: ${revealText?.substring(0, 50)}...`);

            let baseMessageContent = "";
            const roundPrefix = isMultiRound ? `(Round ${gameState.currentRound}/${gameState.totalRounds}) ` : "";

            if (reason === "guessed" && gameState.winner) {
                const seconds = typeof timeTakenMs === 'number' ? Math.round(timeTakenMs / 1000) : null;
                const timeString = seconds !== null ? ` in ${seconds}s` : '';
                baseMessageContent = `${roundPrefix}✅ @${gameState.winner.displayName} guessed: ${gameState.targetLocation.name}${timeString}! ${revealText || '(Summary unavailable)'}`;
            } else if (reason === "timeout") {
                baseMessageContent = `${roundPrefix}⏱️ ${revealText || `Time's up! The location was ${gameState.targetLocation.name}. (Summary unavailable)`}`;
            } else if (reason === "stopped") {
                baseMessageContent = `${roundPrefix}🛑 ${revealText || `Game stopped. The location was ${gameState.targetLocation.name}. (Summary unavailable)`}`;
            } else { // timer_error or other unknown
                 baseMessageContent = `${roundPrefix}📢 The answer was: ${gameState.targetLocation.name}! ${revealText || '(Summary unavailable)'}`;
            }

            roundEndMessage = baseMessageContent;

            // Summarize if necessary (same logic as before)
            if (roundEndMessage.length > MAX_IRC_MESSAGE_LENGTH) {
                 logger.info(`[GeoGame][${gameState.channelName}] Round end message too long (${roundEndMessage.length} chars). Attempting summarization.`);
                 try {
                    const summaryInput = revealText || baseMessageContent; // Prioritize reveal text for summary
                    const summary = await summarizeText(summaryInput, SUMMARY_TARGET_LENGTH);
                     if (summary?.trim()) {
                         const summaryText = summary.trim();
                         if (reason === "guessed" && gameState.winner) {
                            const seconds = typeof timeTakenMs === 'number' ? Math.round(timeTakenMs / 1000) : null;
                            const timeString = seconds !== null ? ` in ${seconds}s` : '';
                            roundEndMessage = `${roundPrefix}✅ @${gameState.winner.displayName} guessed: ${gameState.targetLocation.name}${timeString}! ${summaryText}`;
                         } else if (reason === "timeout") {
                            roundEndMessage = `${roundPrefix}⏱️ ${summaryText}`;
                         } else if (reason === "stopped") {
                            roundEndMessage = `${roundPrefix}🛑 ${summaryText}`;
                         } else {
                            roundEndMessage = `${roundPrefix}📢 The answer was: ${gameState.targetLocation.name}! ${summaryText}`;
                         }
                         logger.info(`[GeoGame][${gameState.channelName}] Summarization successful (${roundEndMessage.length} chars).`);
                    } else {
                         logger.warn(`[GeoGame][${gameState.channelName}] Summarization failed. Falling back to original (potentially truncated by IRC).`);
                         roundEndMessage = baseMessageContent; // Fallback
                    }
                } catch (summaryError) {
                     logger.error({ err: summaryError }, `[GeoGame][${gameState.channelName}] Error during summarization. Falling back to original.`);
                     roundEndMessage = baseMessageContent; // Fallback
                }
            }
        } catch (error) {
            logger.error({ err: error }, `[GeoGame][${gameState.channelName}] Error generating round reveal or formatting message.`);
            roundEndMessage = `An error occurred revealing the answer for round ${gameState.currentRound}.`;
        }
    }

    enqueueMessage(`#${gameState.channelName}`, roundEndMessage || "The round has ended.");
    logger.debug(`[GeoGame][${gameState.channelName}] Round end message sent.`);

    // --- 3. Record Game History (Always record each round) ---
    // Determine if the reason for ending warrants recording the result
    const validEndReasonForRecording = ['guessed', 'timeout', 'stopped'].includes(reason);

    if (gameState.config.scoreTracking && gameState.targetLocation?.name && validEndReasonForRecording) {
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
                roundNumber: gameState.currentRound,
                totalRounds: gameState.totalRounds,
            };
            logger.debug(`[GeoGame][${gameState.channelName}] Calling recordGameResult for round ${gameState.currentRound}.`);
            await recordGameResult(gameDetails);
            logger.debug(`[GeoGame][${gameState.channelName}] Successfully awaited recordGameResult call for round ${gameState.currentRound}.`);
        } catch (storageError) {
            logger.error({ err: storageError }, `[GeoGame][${gameState.channelName}] Error explicitly caught from recordGameResult call for round ${gameState.currentRound}.`);
        }
    } else {
        // Log why recording was skipped, including all relevant conditions
        logger.debug(`[GeoGame][${gameState.channelName}] Skipping recordGameResult call. Conditions: scoreTracking=${gameState.config.scoreTracking}, targetLocation=${!!gameState.targetLocation?.name}, reason=${reason}, validEndReason=${validEndReasonForRecording}`);
    }

    // --- 4. Determine Next Step (Next Round, Game Over, or Stop) ---
    if (reason === "stopped" || reason === "timer_error") {
        // Manual stop or critical timer error ends the whole game immediately
        logger.info(`[GeoGame][${gameState.channelName}] Game session ended prematurely (stop/error). Reporting final scores if multi-round.`);
        if (isMultiRound && gameState.gameSessionScores.size > 0) {
            // Report session scores if it was multi-round and scores exist
            const sessionScoresMessage = formatGameSessionScoresMessage(gameState.gameSessionScores);
            enqueueMessage(`#${gameState.channelName}`, `🏁 Game stopped. Final Session Scores: ${sessionScoresMessage}`);
        } else {
            // Optionally send a message that the game was stopped before scores could be tallied if single round/no scores
        }
        // Full reset after a delay
        setTimeout(() => _resetGameToIdle(gameState), MULTI_ROUND_DELAY_MS);

    } else if (isMultiRound && !isLastRound) {
        // --- Start Next Round ---
        logger.info(`[GeoGame][${gameState.channelName}] Proceeding to round ${gameState.currentRound + 1}.`);
        gameState.currentRound++;
        // Reset round-specific state *before* starting next round
        gameState.targetLocation = null;
        gameState.startTime = null;
        gameState.clues = [];
        gameState.currentClueIndex = -1;
        gameState.guesses = [];
        gameState.winner = null;
        gameState.incorrectGuessReasons = [];
        // Keep gameSessionScores, totalRounds, currentRound, gameSessionExcludedLocations

        // Start next round after a delay
        setTimeout(() => _startNextRound(gameState), MULTI_ROUND_DELAY_MS);

    } else {
        // --- Game Over (Last Round Completed or Single Round Game) ---
        logger.info(`[GeoGame][${gameState.channelName}] Game session finished. Reporting final results.`);

        // a) Report Session Scores (if multi-round)
        if (isMultiRound && gameState.gameSessionScores.size > 0) {
            const sessionScoresMessage = formatGameSessionScoresMessage(gameState.gameSessionScores);
            enqueueMessage(`#${gameState.channelName}`, `🏁 Final Session Scores: ${sessionScoresMessage}`);
             await new Promise(resolve => setTimeout(resolve, 1000)); // Small delay before leaderboard
        } else if (isMultiRound) {
             enqueueMessage(`#${gameState.channelName}`, `🏁 Game finished. No scores recorded in this session.`);
             await new Promise(resolve => setTimeout(resolve, 1000)); // Small delay
        }

        // b) Report Overall Channel Leaderboard (if score tracking enabled)
        if (gameState.config.scoreTracking) {
            try {
                const leaderboardData = await getLeaderboard(gameState.channelName, 5);
                // Need the formatter from geo.js - let's re-implement a simple version here or import if possible
                // Re-implementing for simplicity now:
                let leaderboardMessage = `🏆 Overall Top Players in #${gameState.channelName}: `;
                if (!leaderboardData || leaderboardData.length === 0) {
                    leaderboardMessage += `No stats yet!`;
                } else {
                    const sortedData = leaderboardData.sort((a, b) => (b.data?.channelWins || 0) - (a.data?.channelWins || 0));
                    const topPlayers = sortedData.slice(0, 5);
                    leaderboardMessage += topPlayers.map((p, i) => `${i + 1}. ${p.data?.displayName || p.id} (${p.data?.channelWins || 0} wins)`).join(', ');
                }
                enqueueMessage(`#${gameState.channelName}`, leaderboardMessage);
            } catch (error) {
                logger.error({ err: error, channel: gameState.channelName }, `[GeoGame][${gameState.channelName}] Failed to fetch or format overall leaderboard.`);
                enqueueMessage(`#${gameState.channelName}`, `Could not fetch the overall channel leaderboard.`);
            }
        }

        // c) Full Reset after delay
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
             logger.warn(`[GeoGame][${gameState.channelName}] selectLocation returned an excluded location (\"${locationAttempt.name}\") for round ${gameState.currentRound}. Retrying.`);
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

    logger.info(`[GeoGame][${channelName}] Round ${gameState.currentRound} started successfully.`);
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
    gameState.gameSessionScores = new Map();
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
                logger.warn(`[GeoGame][${channelName}] selectLocation returned an excluded location (\"${locationAttempt.name}\") for Round 1. Retrying.`);
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
        return; // Only process guesses during 'inProgress' state of a round
    }

    // Basic throttling
    const now = Date.now();
    if (now - gameState.lastMessageTimestamp < 1000) {
        // logger.trace(`[GeoGame][${channelName}] Throttling guess from ${username}.`); // Can be noisy
        return;
    }
    gameState.lastMessageTimestamp = now;

    const trimmedGuess = guess.trim();
    if (!trimmedGuess) return;

    logger.debug(`[GeoGame][${channelName}] Processing guess for round ${gameState.currentRound}: "${trimmedGuess}" from ${username}`);
    // Store guess with round number for potential analysis later? For now, just push.
    gameState.guesses.push({ username, displayName, guess: trimmedGuess, timestamp: new Date(), round: gameState.currentRound });

    try {
        // Validate against the *current round's* target location
        const validationResult = await validateGuess(gameState.targetLocation.name, trimmedGuess, gameState.targetLocation.alternateNames);

        // Check state again *after* validation, as it might change
        if (gameState.state !== 'inProgress') {
            logger.debug(`[GeoGame][${channelName}] Game state changed to ${gameState.state} while validating guess from ${username} for round ${gameState.currentRound}. Ignoring result.`);
            return;
        }

        if (validationResult && validationResult.is_correct) {
            logger.info(`[GeoGame][${channelName}] Correct guess for round ${gameState.currentRound} "${trimmedGuess}" by ${username}. Confidence: ${validationResult.confidence || 'N/A'}`);
            // Set the winner *for this round*
            gameState.winner = { username, displayName };
            gameState.state = 'guessed'; // Mark round as guessed

            const timeTakenMs = Date.now() - gameState.startTime; // Time taken for *this round*
            // Transition to ending logic, passing round winner and time
            _transitionToEnding(gameState, "guessed", timeTakenMs); // Handles next round or game over
        } else {
            // Store incorrect guess reason (for the current round)
            const reason = validationResult?.reasoning?.trim();
            if (reason) {
                 if (!gameState.incorrectGuessReasons.includes(reason)) {
                    gameState.incorrectGuessReasons.push(reason);
                    if (gameState.incorrectGuessReasons.length > 5) {
                        gameState.incorrectGuessReasons.shift();
                    }
                    logger.debug(`[GeoGame][${channelName}] Stored incorrect guess reason for round ${gameState.currentRound}: "${reason}".`);
                 }
            } else {
                 // logger.debug(`[GeoGame][${channelName}] Incorrect guess by ${username} for round ${gameState.currentRound}.`); // Can be noisy
            }
        }
    } catch (error) {
        logger.error({ err: error }, `[GeoGame][${channelName}] Error validating guess "${trimmedGuess}" from ${username} for round ${gameState.currentRound}.`);
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
        clearLeaderboard
    };
}

export { initializeGeoGameManager, getGeoGameManager };