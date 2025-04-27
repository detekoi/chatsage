import logger from '../../lib/logger.js';
import { enqueueMessage } from '../../lib/ircSender.js';
import { selectLocation, validateGuess } from './geoLocationService.js';
import { generateInitialClue, generateFollowUpClue, generateFinalReveal } from './geoClueService.js';
import { formatStartMessage, formatClueMessage, formatCorrectGuessMessage, formatTimeoutMessage, formatStopMessage, formatRevealMessage } from './geoMessageFormatter.js';
import { loadChannelConfig, saveChannelConfig, recordGameResult, updatePlayerScore, getRecentLocations } from './geoStorage.js';

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
    startTime: number | null; // timestamp ms
    clues: string[];
    currentClueIndex: number;
    nextClueTimer: NodeJS.Timeout | null;
    roundEndTimer: NodeJS.Timeout | null;
    guesses: PlayerGuess[];
    winner: { username: string, displayName: string } | null;
    config: GameConfig; // Channel-specific config
    lastMessageTimestamp: number; // To help throttle guesses if needed
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

// --- In-Memory Storage for Active Games ---
/** @type {Map<string, GameState>} */
const activeGames = new Map(); // channelName -> GameState

// --- Helper Functions ---
async function _getOrCreateGameState(channelName) {
    if (!activeGames.has(channelName)) {
        logger.debug(`[GeoGame] Creating new game state for channel: ${channelName}`);
        
        // Load config from Firebase or use default
        let loadedConfig = await loadChannelConfig(channelName);
        if (!loadedConfig) {
            logger.info(`[GeoGame][${channelName}] No saved config found, using default.`);
            loadedConfig = { ...DEFAULT_CONFIG };
            // Optionally save the default config immediately
            await saveChannelConfig(channelName, loadedConfig);
        } else {
            logger.info(`[GeoGame][${channelName}] Loaded saved config.`);
            // Ensure loaded config has all default keys (in case defaults changed)
            loadedConfig = { ...DEFAULT_CONFIG, ...loadedConfig };
        }
        
        activeGames.set(channelName, {
            channelName,
            mode: 'real', // Default mode
            state: 'idle',
            targetLocation: null,
            gameTitleScope: null,
            startTime: null,
            clues: [],
            currentClueIndex: -1,
            nextClueTimer: null,
            roundEndTimer: null,
            guesses: [],
            winner: null,
            config: loadedConfig, // Use loaded config
            lastMessageTimestamp: 0,
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

async function _transitionToEnding(gameState, reason = "guessed") {
    _clearTimers(gameState);

    // Prevent multiple endings/resets if already ending
    if (gameState.state === 'ending') {
        logger.warn(`[GeoGame][${gameState.channelName}] Already in ending state. Ignoring transition request (Reason: ${reason}).`);
        return;
    }

    const previousState = gameState.state; // Keep track if it was inProgress for messages
    gameState.state = 'ending';
    logger.info(`[GeoGame][${gameState.channelName}] Game ending. Reason: ${reason}`);

    let revealText = null;
    let finalMessage = "";

    // Ensure target location exists before attempting reveal
    if (!gameState.targetLocation?.name) {
        logger.error(`[GeoGame][${gameState.channelName}] Cannot generate final reveal: targetLocation is missing.`);
        finalMessage = "An error occurred, and the final location couldn't be revealed."; // Fallback message
    } else {
        try {
            revealText = await generateFinalReveal(gameState.targetLocation.name);
            logger.debug(`[GeoGame][${gameState.channelName}] Reveal text generated: ${revealText?.substring(0, 50)}...`);
        } catch (error) {
            logger.error({ err: error }, `[GeoGame][${gameState.channelName}] Error generating final reveal.`);
            revealText = `(Could not generate final summary: ${error.message})`; // Include error in reveal if generation fails
        }

        // Choose the final message format based on the reason for ending
        switch (reason) {
            case "guessed":
                // Correct guess message was already sent by _handleGuess
                // We just need to send the reveal info
                finalMessage = formatRevealMessage(gameState.targetLocation.name, revealText);
                break;
            case "timeout":
                // Timeout message was already sent by the roundEndTimer
                finalMessage = formatRevealMessage(gameState.targetLocation.name, revealText);
                break;
            case "stopped":
                // Stop message was already sent by stopGame
                finalMessage = formatRevealMessage(gameState.targetLocation.name, revealText);
                break;
            default:
                logger.warn(`[GeoGame][${gameState.channelName}] Unknown ending reason: ${reason}. Using default reveal.`);
                finalMessage = formatRevealMessage(gameState.targetLocation.name, revealText);
        }
    }

    // Enqueue the formatted final message (reveal details)
    if (finalMessage) {
        enqueueMessage(`#${gameState.channelName}`, finalMessage);
    }
    
    // Record game results if score tracking is enabled
    if (gameState.config.scoreTracking && gameState.targetLocation?.name) {
        try {
            // Create game result details
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
            };
            
            // Record game history
            await recordGameResult(gameDetails);
            
            // Update winner score if there was a winner
            if (gameState.winner?.username) {
                await updatePlayerScore(gameState.winner.username, gameState.channelName, 1, gameState.winner.displayName);
                logger.debug(`[GeoGame][${gameState.channelName}] Updated score for winner: ${gameState.winner.username} (${gameState.winner.displayName})`);
            }
        } catch (storageError) {
            logger.error({ err: storageError }, `[GeoGame][${gameState.channelName}] Error saving game stats.`);
        }
    }

    // Reset state after a short delay to allow final messages to be sent/read
    setTimeout(async () => {
        logger.info(`[GeoGame][${gameState.channelName}] Resetting game state to idle.`);
        const config = gameState.config; // Preserve config
        // Use _getOrCreateGameState to get a fresh structure, then overwrite with persisted config
        const newState = await _getOrCreateGameState(gameState.channelName); // Gets initial structure & sets it in map
        newState.config = config; // Restore preserved config
        newState.state = 'idle'; // Ensure it's explicitly idle
        // Explicitly clear game-specific data
        newState.targetLocation = null;
        newState.startTime = null;
        newState.clues = [];
        newState.currentClueIndex = -1;
        newState.guesses = [];
        newState.winner = null;
        _clearTimers(newState); // Clear timers again just in case
    }, 7000); // 7 second delay before full reset (increased slightly)
}


// --- Core Game Logic ---

async function _scheduleNextClue(gameState) {
    _clearTimers(gameState); // Clear previous timer before setting a new one

    // Maximum clues reached (e.g., 5 clues total, index 0-4)
    if (gameState.currentClueIndex >= 4) {
        logger.info(`[GeoGame][${gameState.channelName}] Maximum clues (${gameState.currentClueIndex + 1}) reached. Round timer will determine end.`);
        return; // Don't schedule more clues
    }

    const delaySeconds = gameState.config.clueIntervalSeconds;
    logger.debug(`[GeoGame][${gameState.channelName}] Scheduling clue ${gameState.currentClueIndex + 2} in ${delaySeconds} seconds.`);

    gameState.nextClueTimer = setTimeout(async () => {
        // Check if the game state is still valid for sending a clue
        if (gameState.state !== 'inProgress') {
            logger.debug(`[GeoGame][${gameState.channelName}] Game state changed to ${gameState.state} before next clue timer fired. Aborting clue generation.`);
            return;
        }

        logger.info(`[GeoGame][${gameState.channelName}] Clue timer expired, generating clue ${gameState.currentClueIndex + 2}.`);
        try {
            const nextClue = await generateFollowUpClue(gameState.targetLocation.name, gameState.clues);
            if (nextClue) {
                // Check state again *after* await, just in case it changed during generation
                if (gameState.state !== 'inProgress') {
                     logger.debug(`[GeoGame][${gameState.channelName}] Game state changed during clue generation. Aborting clue send.`);
                     return;
                }
                gameState.clues.push(nextClue);
                gameState.currentClueIndex++;
                const clueMessage = formatClueMessage(gameState.currentClueIndex + 1, nextClue);
                enqueueMessage(`#${gameState.channelName}`, clueMessage);

                // Schedule the *next* clue after this one is sent
                _scheduleNextClue(gameState);
            } else {
                 logger.warn(`[GeoGame][${gameState.channelName}] Failed to generate follow-up clue ${gameState.currentClueIndex + 2}.`);
                 // Consider ending early or just let the round timer handle it. Current: let round timer handle.
            }
        } catch (error) {
             logger.error({ err: error }, `[GeoGame][${gameState.channelName}] Error generating or sending follow-up clue ${gameState.currentClueIndex + 2}.`);
             // Consider notifying the channel or ending the game? For now, just log.
        }
    }, delaySeconds * 1000);
}

const MAX_LOCATION_SELECT_RETRIES = 3;

async function _startGameProcess(channelName, mode, gameTitle = null) {
    const gameState = await _getOrCreateGameState(channelName);

    if (gameState.state !== 'idle') {
        logger.warn(`[GeoGame][${channelName}] Attempted to start game while state is ${gameState.state}`);
        return { success: false, error: `A game is already active or ending (${gameState.state}). Please wait or use !geo stop.` };
    }

    // Reset core game fields before starting
    gameState.mode = mode;
    gameState.gameTitleScope = gameTitle;
    gameState.state = 'selecting'; // Initial state during setup
    gameState.targetLocation = null;
    gameState.startTime = null;
    gameState.clues = [];
    gameState.currentClueIndex = -1;
    gameState.guesses = [];
    gameState.winner = null;
    _clearTimers(gameState); // Ensure no stray timers from a previous errored state

    logger.info(`[GeoGame][${channelName}] Starting new game process. Mode: ${mode}, Game Scope: ${gameTitle || 'N/A'}`);

    try {
        let selectedLocation = null;
        let retries = 0;
        while (!selectedLocation && retries < MAX_LOCATION_SELECT_RETRIES) {
            if (retries > 0) {
                logger.warn(`[GeoGame][${channelName}] Retrying location selection (Attempt ${retries + 1})...`);
                await new Promise(resolve => setTimeout(resolve, 500 * retries));
            }
            const excludedLocations = await getRecentLocations(channelName, 10);
            logger.debug(`[GeoGame][${channelName}] Locations to exclude: ${excludedLocations.join(', ')}`);
            const locationAttempt = await selectLocation(mode, gameState.config, gameTitle, excludedLocations);
            if (locationAttempt?.name && !excludedLocations.includes(locationAttempt.name)) {
                selectedLocation = locationAttempt;
            } else if (locationAttempt?.name) {
                logger.warn(`[GeoGame][${channelName}] selectLocation returned an excluded location ("${locationAttempt.name}"). Retrying.`);
            } else {
                logger.warn(`[GeoGame][${channelName}] selectLocation returned null or invalid name. Retrying.`);
            }
            retries++;
        }
        if (!selectedLocation) {
            throw new Error(`Failed to select a valid, non-repeated location after ${MAX_LOCATION_SELECT_RETRIES} attempts.`);
        }
        gameState.targetLocation = { name: selectedLocation.name, alternateNames: selectedLocation.alternateNames || [] };
        logger.info(`[GeoGame][${channelName}] Location selected: ${gameState.targetLocation.name}`);

        // 2. Generate Initial Clue
        const firstClue = await generateInitialClue(gameState.targetLocation.name, gameState.config.difficulty);
        if (!firstClue) {
            throw new Error("Failed to generate the initial clue.");
        }
        gameState.clues.push(firstClue);
        gameState.currentClueIndex = 0;
        logger.info(`[GeoGame][${channelName}] First clue generated.`);

        // 3. Start Game Timers & Send Messages
        gameState.startTime = Date.now();
        gameState.state = 'started'; // Mark as formally started before sending message

        const startMessage = formatStartMessage(mode, gameTitle, gameState.config.roundDurationMinutes); // Pass duration
        enqueueMessage(`#${channelName}`, startMessage);

        // Small delay before sending the first clue for better flow
        await new Promise(resolve => setTimeout(resolve, 1500)); // Slightly longer delay

        // Check if state changed during the delay (e.g., manual stop)
        if (gameState.state !== 'started') {
            logger.warn(`[GeoGame][${channelName}] Game state changed to ${gameState.state} before first clue could be sent. Aborting start.`);
            // State might already be 'ending', _transitionToEnding handles reset. If not, reset here.
             if(gameState.state !== 'ending') {
                gameState.state = 'idle';
                _clearTimers(gameState);
             }
            return { success: false, error: "Game was stopped before the first clue." };
        }

        const clueMessage = formatClueMessage(1, firstClue);
        enqueueMessage(`#${channelName}`, clueMessage);

        // Transition to 'inProgress' after the first clue is successfully sent
        gameState.state = 'inProgress';
        logger.info(`[GeoGame][${channelName}] Game transitioned to inProgress.`);

        // 4. Schedule Subsequent Clues and Round End Timer
        _scheduleNextClue(gameState);

        const roundDurationMs = gameState.config.roundDurationMinutes * 60 * 1000;
        logger.info(`[GeoGame][${channelName}] Round end timer scheduled for ${gameState.config.roundDurationMinutes} minutes (${roundDurationMs}ms).`);
        gameState.roundEndTimer = setTimeout(() => {
            // Only trigger timeout logic if the game is still actively in progress
            if (gameState.state === 'inProgress') {
                 logger.info(`[GeoGame][${channelName}] Round timer expired. Game timed out.`);
                 gameState.state = 'timeout'; // Mark state *before* sending message/transitioning
                 const timeoutMessage = formatTimeoutMessage(gameState.targetLocation.name);
                 enqueueMessage(`#${channelName}`, timeoutMessage);
                 _transitionToEnding(gameState, "timeout"); // Handle reveal and reset
            } else {
                 logger.debug(`[GeoGame][${channelName}] Round timer expired, but game state is ${gameState.state}. No timeout action needed.`);
            }
        }, roundDurationMs);

        logger.info(`[GeoGame][${channelName}] Game started successfully. Target: ${gameState.targetLocation.name}. First clue sent.`);
        // The command handler will send the confirmation message to the user who started it
        return { success: true, message: `Geo-Game started! Mode: ${mode}${gameTitle ? ` (${gameTitle})` : ''}. Good luck!` };

    } catch (error) {
        logger.error({ err: error }, `[GeoGame][${channelName}] Critical error during game start process.`);
        // Ensure state is reset cleanly on critical failure
        gameState.state = 'idle';
        _clearTimers(gameState);
        // Provide a more specific error if possible, otherwise generic
        const userError = error.message.includes("Failed to select") || error.message.includes("Failed to generate")
            ? `Error starting game: ${error.message}`
            : "An unexpected error occurred while starting the game. Please try again later.";
        return { success: false, error: userError };
    }
}

async function _handleGuess(channelName, username, displayName, guess) {
    const gameState = activeGames.get(channelName);

    // Only process guesses if a game is actively in progress
    if (!gameState || gameState.state !== 'inProgress') {
        // logger.trace(`[GeoGame][${channelName}] Ignoring guess from ${username} - game state is ${gameState?.state || 'inactive'}.`);
        return;
    }

    // Basic throttling check (e.g., 1 guess per user per 3 seconds) - Optional but recommended
    // Could also store last guess timestamp per user in gameState.guesses if needed
    const now = Date.now();
    if (now - gameState.lastMessageTimestamp < 1000) { // Simple global throttle (1s)
        logger.trace(`[GeoGame][${channelName}] Throttling guess from ${username}.`);
         return;
    }
    gameState.lastMessageTimestamp = now; // Update last message time

    const trimmedGuess = guess.trim();
    if (!trimmedGuess) return; // Ignore empty messages

    logger.debug(`[GeoGame][${channelName}] Processing guess: "${trimmedGuess}" from ${username}`);
    gameState.guesses.push({ username, displayName, guess: trimmedGuess, timestamp: new Date() });

    try {
        // Validate guess using the location service (which uses LLM)
        const validationResult = await validateGuess(gameState.targetLocation.name, trimmedGuess, gameState.targetLocation.alternateNames);

        // Check state *again* after await, in case it changed (e.g., timed out) while validating
        if (gameState.state !== 'inProgress') {
             logger.debug(`[GeoGame][${channelName}] Game state changed to ${gameState.state} while validating guess from ${username}. Ignoring result.`);
             return;
        }

        if (validationResult && validationResult.is_correct) {
            logger.info(`[GeoGame][${channelName}] Correct guess "${trimmedGuess}" by ${username} for ${gameState.targetLocation.name}. Confidence: ${validationResult.confidence || 'N/A'}`);
            gameState.winner = { username, displayName };
            gameState.state = 'guessed'; // Update state *before* sending message/transitioning

            const timeTakenMs = Date.now() - gameState.startTime;
            const correctMessage = formatCorrectGuessMessage(displayName, gameState.targetLocation.name, timeTakenMs);
            enqueueMessage(`#${channelName}`, correctMessage);

            // Transition to ending state (clears timers, reveals info, resets)
            _transitionToEnding(gameState, "guessed");

        } else {
             // Log incorrect guess reason if available from LLM
             logger.debug(`[GeoGame][${channelName}] Incorrect guess by ${username}. Reason: ${validationResult?.reasoning || 'Validation inconclusive'}`);
             // Optional: Provide feedback for near misses based on confidence or keywords?
             // Example: if (validationResult?.reasoning?.toLowerCase().includes("close")) { ... }
        }
    } catch (error) {
        // Log error but don't crash the game
        logger.error({ err: error }, `[GeoGame][${channelName}] Error validating guess "${trimmedGuess}" from ${username}.`);
        // Optionally inform the user? Could be noisy.
        // enqueueMessage(`#${channelName}`, `@${displayName}, sorry, there was an error checking your guess.`);
    }
}


// --- Public Interface ---

/**
 * Initializes the GeoGame Manager.
 */
async function initializeGeoGameManager() {
    logger.info("Initializing GeoGame Manager...");
    // Ensure storage is already initialized in bot.js before this is called
    activeGames.clear(); // Ensure clean slate on initialization
    
    // Note: We don't pre-load configs for all channels here,
    // they'll be loaded on demand when games are started in each channel
    logger.info("GeoGame Manager initialized successfully.");
}

/**
 * Starts a new game round in the specified channel.
 * Calls the internal _startGameProcess and returns its result.
 * @param {string} channelName - Channel name (without #).
 * @param {'real' | 'game'} mode - Game mode.
 * @param {string | null} [gameTitle=null] - Specific game title for 'game' mode.
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
async function startGame(channelName, mode, gameTitle = null) {
    // Directly call the internal process function
    return await _startGameProcess(channelName, mode, gameTitle);
}

/**
 * Stops the currently active game in a channel.
 * @param {string} channelName - Channel name (without #).
 * @returns {{message: string}} Result message for the command issuer.
 */
function stopGame(channelName) {
    const gameState = activeGames.get(channelName);

    // Check if there's actually a game to stop (in a stoppable state)
    if (!gameState || gameState.state === 'idle' || gameState.state === 'ending' || gameState.state === 'guessed' || gameState.state === 'timeout') {
        const stateMsg = gameState ? `(state: ${gameState.state})` : '(no game active)';
        logger.debug(`[GeoGame][${channelName}] Stop command received, but no stoppable game found ${stateMsg}.`);
        return { message: "No active Geo-Game round to stop in this channel." };
    }

    logger.info(`[GeoGame][${channelName}] Stop command received. Manually ending game from state: ${gameState.state}.`);

    // Store location name before potentially clearing timers/state changes affect it
    const locationName = gameState.targetLocation?.name;

    // Send the stop message *before* transitioning, using the formatter
    const stopMessage = formatStopMessage(locationName); // Pass location if available
    enqueueMessage(`#${channelName}`, stopMessage);

    // Transition to the ending sequence (clears timers, handles reveal/reset)
    // Pass "stopped" as the reason. _transitionToEnding handles state change and timers.
    _transitionToEnding(gameState, "stopped");

    // Return confirmation message for the user who issued the command
    return { message: "Geo-Game stopped successfully." };
}

/**
 * Processes a chat message to check if it's a potential guess for an active game.
 * Delegates the actual handling and validation to _handleGuess.
 * @param {string} channelName - Channel name (without #).
 * @param {string} username - User's lowercase username.
 * @param {string} displayName - User's display name.
 * @param {string} message - The chat message text.
 */
function processPotentialGuess(channelName, username, displayName, message) {
    const gameState = activeGames.get(channelName);
    // Basic check: only process if game is 'inProgress' and message isn't a command
    if (gameState && gameState.state === 'inProgress' && !message.startsWith('!')) {
        // Asynchronously handle the guess validation and potential state changes
        _handleGuess(channelName, username, displayName, message.trim()).catch(err => {
             // Catch unhandled errors from the async guess handler
             logger.error({ err, channel: channelName, user: username }, `[GeoGame][${channelName}] Unhandled error processing potential guess.`);
        });
    }
    // Otherwise, do nothing (message is ignored as a guess)
}

/**
 * Configures game settings for a channel. (Currently Placeholder)
 * @param {string} channelName - Channel to configure.
 * @param {object} options - Key-value pairs of settings to update.
 * @returns {{message: string}} Result message.
 */
async function configureGame(channelName, options) {
    const gameState = await _getOrCreateGameState(channelName); // Ensures state exists
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
        gameState.config.regionRestrictions = options.regionRestrictions;
        changesMade.push(`Region restrictions updated to: ${options.regionRestrictions.join(', ') || 'None'}`);
        configChanged = true;
    }

    if (configChanged) {
        // Persist config changes using geoStorage.js
        const success = await saveChannelConfig(channelName, gameState.config);
        if (success) {
            logger.info(`[GeoGame][${channelName}] Configuration updated and saved: ${changesMade.join(', ')}`);
            return { message: `Geo-Game settings updated: ${changesMade.join('. ')}.` };
        } else {
            logger.error(`[GeoGame][${channelName}] Failed to save configuration changes.`);
            return { message: `Settings updated in memory, but failed to save them permanently.` };
        }
    } else if (changesMade.length > 0 && !configChanged) {
        // Changes were attempted but values were invalid or same as current
        return { message: `Geo-Game settings not changed: ${changesMade.join('. ')}` };
    } else {
        return { message: "No valid configuration options provided or settings are already up-to-date. Use !geo help config for options." };
    }
}


/**
 * Gets the singleton GeoGame Manager instance/interface.
 */
function getGeoGameManager() {
    // Expose public methods for external use (e.g., command handlers)
    return {
        initialize: initializeGeoGameManager,
        startGame,
        stopGame,
        processPotentialGuess,
        configureGame,
        // Might add: getCurrentGameState(channelName) if needed for status commands
    };
}

export { initializeGeoGameManager, getGeoGameManager };