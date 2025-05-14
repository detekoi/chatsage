import config from './config/index.js';
import logger from './lib/logger.js';
import http from 'http';
// Import Secret Manager initializer and getSecretValue
import { initializeSecretManager, getSecretValue } from './lib/secretManager.js';
import { createIrcClient, connectIrcClient, getIrcClient } from './components/twitch/ircClient.js';
import { initializeHelixClient, getHelixClient } from './components/twitch/helixClient.js';
import { initializeGeminiClient, getGeminiClient, generateStandardResponse as generateLlmResponse, translateText, summarizeText } from './components/llm/geminiClient.js';
import { initializeContextManager, getContextManager, getUserTranslationState, disableUserTranslation, disableAllTranslationsInChannel } from './components/context/contextManager.js';
import { initializeCommandProcessor, processMessage as processCommand } from './components/commands/commandProcessor.js';

import { startStreamInfoPolling, stopStreamInfoPolling } from './components/twitch/streamInfoPoller.js';
import { initializeIrcSender, enqueueMessage, clearMessageQueue } from './lib/ircSender.js';
import { handleStandardLlmQuery } from './components/llm/llmUtils.js';
import { initializeGeoGameManager, getGeoGameManager } from './components/geo/geoGameManager.js';
import { initializeStorage } from './components/geo/geoStorage.js';
import { initializeTriviaGameManager, getTriviaGameManager } from './components/trivia/triviaGameManager.js';
import { initializeStorage as initializeTriviaStorage } from './components/trivia/triviaStorage.js';
import { initializeChannelManager, getActiveManagedChannels, syncManagedChannelsWithIrc, listenForChannelChanges } from './components/twitch/channelManager.js';
import { initializeLanguageStorage } from './components/context/languageStorage.js';
import { initializeRiddleStorage } from './components/riddle/riddleStorage.js';
import { initializeRiddleGameManager, getRiddleGameManager } from './components/riddle/riddleGameManager.js';

let streamInfoIntervalId = null;
let ircClient = null;
let channelChangeListener = null;
const MAX_IRC_MESSAGE_LENGTH = 450; // Define globally for reuse
const SUMMARY_TARGET_LENGTH = 400;  // Define globally for reuse
const CHANNEL_SYNC_INTERVAL_MS = 300000; // 5 minutes

// Helper function for checking mod/broadcaster status
function isPrivilegedUser(tags, channelName) {
    const isMod = tags.mod === '1' || tags.badges?.moderator === '1';
    const isBroadcaster = tags.badges?.broadcaster === '1' || tags.username === channelName;
    return isMod || isBroadcaster;
}

/**
 * Gracefully shuts down the application.
 */
async function gracefulShutdown(signal) {
    
    const shutdownTasks = [];
    
    // Close health check server if it exists
    if (global.healthServer) {
        shutdownTasks.push(
            new Promise((resolve) => {
                global.healthServer.close(() => {
                    logger.info('Health check server closed.');
                    resolve();
                });
            })
        );
    }
    
    // Clean up channel change listener if active
    if (channelChangeListener) {
        try {
            logger.info('Cleaning up channel change listener during shutdown...');
            channelChangeListener();
            channelChangeListener = null;
        } catch (error) {
            logger.error({ err: error }, 'Error cleaning up channel change listener during shutdown.');
        }
    }
    
    // Clear polling interval immediately
    if (streamInfoIntervalId) {
        stopStreamInfoPolling(streamInfoIntervalId);
        logger.info('Stream info polling stopped.');
    }
    
    // Clear message queue before disconnecting
    clearMessageQueue();
    logger.info('Message queue cleared.');
    
    // Disconnect from Twitch IRC - get clientInstance safely
    let clientInstance = null;
    try {
        clientInstance = ircClient || getIrcClient(); // Try to get existing client instance
    } catch (e) {
        logger.warn('IRC client not initialized, skipping disconnect.');
    }

    if (clientInstance && clientInstance.readyState() === 'OPEN') {
        shutdownTasks.push(
            clientInstance.disconnect().then(() => {
                logger.info('Disconnected from Twitch IRC.');
            }).catch(err => {
                logger.error({ err }, 'Error during IRC disconnect.');
            })
        );
    }
    
    // Run all shutdown tasks in parallel and wait for them to finish
    await Promise.allSettled(shutdownTasks);
    
    // Safety timeout in case something hangs
    const forceExitTimeout = setTimeout(() => {
        logger.error('Force exiting after timeout...');
        process.exit(1);
    }, 5000);
    
    logger.info('ChatSage shutdown complete.');
    clearTimeout(forceExitTimeout);
    process.exit(0);
}

/**
 * Main application function.
 */
async function main() {
    try {
        logger.info(`Starting ChatSage v${process.env.npm_package_version || '1.0.0'}...`);
        logger.info(`Node Env: ${config.app.nodeEnv}, Log Level: ${config.app.logLevel}`);

        // --- Initialize Core Components (Order matters) ---
        
        // 1. Initialize Secret Manager FIRST
        logger.info('Initializing Secret Manager...');
        initializeSecretManager();

        // 2. Initialize Channel Manager and load channels from Firestore
        logger.info('Initializing Channel Manager...');
        await initializeChannelManager();
        
        // --- Load Twitch Channels based on Environment ---
        if (config.app.nodeEnv === 'development') {
            logger.info('Running in DEVELOPMENT mode. Loading channels ONLY from TWITCH_CHANNELS environment variable.');
            if (process.env.TWITCH_CHANNELS) {
                config.twitch.channels = process.env.TWITCH_CHANNELS
                    .split(',')
                    .map(ch => ch.trim().toLowerCase())
                    .filter(ch => ch);
                if (config.twitch.channels.length > 0) {
                    logger.info(`Loaded ${config.twitch.channels.length} channels from .env: [${config.twitch.channels.join(', ')}]`);
                } else {
                    logger.fatal('TWITCH_CHANNELS environment variable is set but contains no valid channels.');
                    process.exit(1);
                }
            } else {
                logger.fatal('Running in DEVELOPMENT mode, but TWITCH_CHANNELS environment variable is not set or empty. Please set it in your .env file.');
                process.exit(1);
            }
        } else {
            // --- Production/Non-Development Channel Loading Logic ---
            logger.info('Running in non-development mode. Loading channels from Firestore (fallback to env/secrets)...');
            try {
                logger.info('Loading Twitch channels from Firestore managedChannels collection...');
                const managedChannels = await getActiveManagedChannels();
                if (managedChannels && managedChannels.length > 0) {
                    config.twitch.channels = managedChannels.map(ch => ch.toLowerCase());
                    logger.info(`Loaded ${config.twitch.channels.length} channels from Firestore.`);
                } else {
                    logger.warn('No active channels found in Firestore managedChannels collection. Falling back...');
                    if (process.env.TWITCH_CHANNELS) {
                        logger.info('Falling back to TWITCH_CHANNELS environment variable...');
                        config.twitch.channels = process.env.TWITCH_CHANNELS
                            .split(',')
                            .map(ch => ch.trim().toLowerCase())
                            .filter(ch => ch);
                        logger.info(`Loaded ${config.twitch.channels.length} channels from environment.`);
                    } else if (config.secrets.twitchChannelsSecretName) {
                        logger.info('Falling back to Secret Manager for channel list...');
                        const channelsString = await getSecretValue(config.secrets.twitchChannelsSecretName);
                        if (channelsString) {
                            config.twitch.channels = channelsString
                                .split(',')
                                .map(ch => ch.trim().toLowerCase())
                                .filter(ch => ch);
                            logger.info(`Loaded ${config.twitch.channels.length} channels from Secret Manager.`);
                        } else {
                            logger.error('Failed to load Twitch channels from Secret Manager fallback.');
                            process.exit(1);
                        }
                    } else {
                        logger.error('No channel configuration found (Firestore, Env, Secrets). Cannot proceed.');
                        process.exit(1);
                    }
                }
            } catch (error) {
                logger.error({ err: error }, 'Error loading channels from Firestore. Falling back...');
                if (process.env.TWITCH_CHANNELS) {
                    logger.info('Falling back to TWITCH_CHANNELS environment variable...');
                    config.twitch.channels = process.env.TWITCH_CHANNELS
                        .split(',')
                        .map(ch => ch.trim().toLowerCase())
                        .filter(ch => ch);
                    logger.info(`Loaded ${config.twitch.channels.length} channels from environment.`);
                } else if (config.secrets.twitchChannelsSecretName) {
                    logger.info('Falling back to Secret Manager for channel list...');
                    const channelsString = await getSecretValue(config.secrets.twitchChannelsSecretName);
                    if (channelsString) {
                        config.twitch.channels = channelsString
                            .split(',')
                            .map(ch => ch.trim().toLowerCase())
                            .filter(ch => ch);
                        logger.info(`Loaded ${config.twitch.channels.length} channels from Secret Manager.`);
                    } else {
                        logger.error('Failed to load Twitch channels from Secret Manager fallback after Firestore error.');
                        process.exit(1);
                    }
                } else {
                    logger.error('No channel configuration found after Firestore error. Cannot proceed.');
                    process.exit(1);
                }
            }
        }
        // Ensure channels are populated before proceeding
        if (!config.twitch.channels || config.twitch.channels.length === 0) {
            logger.fatal('FATAL: No Twitch channels configured to join. Exiting.');
            process.exit(1);
        }

        // 3. Other initializations that might need secrets
        logger.info('Initializing Firebase Storage...');
        await initializeStorage();

        logger.info('Initializing Trivia Storage...');
        await initializeTriviaStorage();

        logger.info('Initializing Riddle Storage...');
        await initializeRiddleStorage();

        logger.info('Initializing Language Storage...');
        await initializeLanguageStorage();

        logger.info('Initializing Gemini Client...');
        initializeGeminiClient(config.gemini);

        logger.info('Initializing Twitch Helix Client...');
        await initializeHelixClient(config.twitch);

        logger.info('Initializing Context Manager...');
        await initializeContextManager(config.twitch.channels);

        logger.info('Initializing Command Processor...');
        initializeCommandProcessor();

        logger.info('Initializing IRC Sender...');
        initializeIrcSender();

        logger.info('Initializing GeoGame Manager...');
        await initializeGeoGameManager();

        logger.info('Initializing Trivia Game Manager...');
        await initializeTriviaGameManager();

        logger.info('Initializing Riddle Game Manager...');
        await initializeRiddleGameManager();

        // --- Get Instances needed before IRC connection ---
        const contextManager = getContextManager();
        const helixClient = getHelixClient();
        const geoManager = getGeoGameManager();
        const triviaManager = getTriviaGameManager();
        const riddleManager = getRiddleGameManager();
        // Get gemini client instance early if needed, or get inside async IIFE
        // const geminiClient = getGeminiClient();

        // --- Create IRC Client Instance (now asynchronous) ---
        logger.info('Creating Twitch IRC Client instance (will fetch token)...');
        ircClient = await createIrcClient(config.twitch);

        // --- Setup IRC Event Listeners BEFORE Connecting ---
        logger.debug('Attaching IRC event listeners...');

        ircClient.on('connected', async (address, port) => {
            logger.info(`Successfully connected to Twitch IRC: ${address}:${port}`);
            
            // --- Conditional Firestore Syncing/Listening ---
            if (config.app.nodeEnv !== 'development') {
                logger.info('Non-dev environment: Setting up Firestore channel listener and sync.');
                // 1. Set up listener for channel changes
                if (!channelChangeListener) {
                    logger.info('Setting up listener for channel changes...');
                    channelChangeListener = listenForChannelChanges(ircClient);
                }
                // 2. Sync channels from Firestore with IRC (Initial Sync after connect)
                try {
                    logger.info('Syncing channels from Firestore with IRC...');
                    const syncResult = await syncManagedChannelsWithIrc(ircClient);
                    logger.info(`Channels synced: ${syncResult.joined.length} joined, ${syncResult.parted.length} parted`);
                    // Update config again after sync if needed
                    const activeChannels = await getActiveManagedChannels();
                    config.twitch.channels = activeChannels.map(ch => ch.toLowerCase());
                    logger.info(`Updated config with ${config.twitch.channels.length} active channels post-sync.`);
                } catch (error) {
                    logger.error({ err: error }, 'Error syncing channels from Firestore post-connect.');
                }
                // 4. Set up recurring channel sync
                setInterval(async () => {
                    try {
                        if (config.app.nodeEnv !== 'development') { // Double check env inside interval
                            logger.info('Running scheduled channel sync...');
                            const syncResult = await syncManagedChannelsWithIrc(ircClient);
                            if (syncResult.joined.length > 0 || syncResult.parted.length > 0) {
                                const activeChannels = await getActiveManagedChannels();
                                config.twitch.channels = activeChannels.map(ch => ch.toLowerCase());
                                logger.info(`Updated config with ${config.twitch.channels.length} active channels after scheduled sync.`);
                            }
                        }
                    } catch (error) {
                        logger.error({ err: error }, 'Error during scheduled channel sync.');
                    }
                }, CHANNEL_SYNC_INTERVAL_MS);
            } else {
                logger.info('Development mode: Skipping Firestore channel listener setup and periodic sync.');
            }
            // --- End Conditional Syncing/Listening ---
            
            // 3. Start stream info polling
            logger.info(`Starting stream info polling every ${config.app.streamInfoFetchIntervalMs / 1000}s...`);
            streamInfoIntervalId = startStreamInfoPolling(
                config.twitch.channels,
                config.app.streamInfoFetchIntervalMs,
                helixClient, // Pass already retrieved instance
                contextManager // Pass already retrieved instance
            );
        });

        ircClient.on('disconnected', (reason) => {
            logger.warn(`Disconnected from Twitch IRC: ${reason || 'Unknown reason'}`);
            stopStreamInfoPolling(streamInfoIntervalId);
            
            // Clean up Firestore listener ONLY if it was started
            if (config.app.nodeEnv !== 'development' && channelChangeListener) {
                logger.info('Cleaning up channel change listener on disconnect...');
                channelChangeListener();
                channelChangeListener = null;
            }
        });

        // --- MESSAGE HANDLER ---
        ircClient.on('message', (channel, tags, message, self) => {
            if (self) {
                // Add self message to context ONLY
                getContextManager().addMessage(channel.substring(1), tags.username, message, tags).catch(err => {
                    logger.error({ err, channel: channel.substring(1), user: tags.username }, 'Error adding self message to context');
                });
                return; // Prevent further processing for self messages
            }

            const cleanChannel = channel.substring(1);
            const lowerUsername = tags.username;
            const displayName = tags['display-name'] || tags.username;
            const contextManager = getContextManager();
            const isModOrBroadcaster = isPrivilegedUser(tags, cleanChannel);

            // --- Stop Translation Check ---
            const lowerMessage = message.toLowerCase().trim();
            const stopTriggers = [
                'stop translating',
                'stop translate'
            ];
            const mentionStopTriggers = [
                `@${config.twitch.username.toLowerCase()} stop`,
                `@${config.twitch.username.toLowerCase()} stop translating`,
                `@${config.twitch.username.toLowerCase()} stop translate`,
                `@${config.twitch.username.toLowerCase()}, stop translating`,
            ];

            let isStopRequest = false;
            let targetUserForStop = lowerUsername; // Default to self
            let stopGlobally = false;

            // Check for command "!translate stop [user|all]"
            if (lowerMessage.startsWith('!translate stop')) {
                isStopRequest = true;
                const parts = message.trim().split(/ +/); // Split by spaces
                if (parts.length > 2) {
                    const target = parts[2].toLowerCase().replace(/^@/, '');
                    if (target === 'all') {
                        if (isModOrBroadcaster) {
                            stopGlobally = true;
                        }
                        // else: command handler will reject permission
                    } else {
                        if (isModOrBroadcaster) {
                            targetUserForStop = target;
                        }
                        // else: command handler will reject permission
                    }
                }
                // If just "!translate stop", targetUserForStop remains self
            }
            // Check for natural language stop phrases
            else if (stopTriggers.some(phrase => lowerMessage === phrase)) {
                isStopRequest = true; // Stop for self
            }
            // Check for mention stop phrases
            else if (mentionStopTriggers.some(phrase => lowerMessage === phrase)) {
                isStopRequest = true; // Stop for self
            }

            // Handle stop request IF IDENTIFIED
            if (isStopRequest) {
                logger.info(`[${cleanChannel}] User ${lowerUsername} initiated stop request (target: ${stopGlobally ? 'all' : targetUserForStop}, global: ${stopGlobally}).`);

                // Add message to context before processing stop
                contextManager.addMessage(cleanChannel, lowerUsername, message, tags).catch(err => {
                    logger.error({ err, channel: cleanChannel, user: lowerUsername }, 'Error adding stop request to context');
                });

                // Execute stop logic (permission check happens in command/here)
                if (stopGlobally) { // Already checked permission above
                    const count = contextManager.disableAllTranslationsInChannel(cleanChannel);
                    enqueueMessage(channel, `@${displayName}, Okay, stopped translations globally for ${count} user(s).`);
                } else {
                    // Check permission if target is not self
                    if (targetUserForStop !== lowerUsername && !isModOrBroadcaster) {
                        enqueueMessage(channel, `@${displayName}, Only mods/broadcaster can stop translation for others.`);
                    } else {
                        const wasStopped = contextManager.disableUserTranslation(cleanChannel, targetUserForStop);
                        if (targetUserForStop === lowerUsername) { // Message for self stop
                            enqueueMessage(channel, wasStopped ? `@${displayName}, Translation stopped.` : `@${displayName}, Translation was already off.`);
                        } else { // Message for mod stopping someone else
                            enqueueMessage(channel, wasStopped ? `@${displayName}, Stopped translation for ${targetUserForStop}.` : `@${displayName}, Translation was already off for ${targetUserForStop}.`);
                        }
                    }
                }
                return; // Stop processing this message further
            }

            // 1. Add message to context
            contextManager.addMessage(cleanChannel, lowerUsername, message, tags).catch(err => {
                logger.error({ err, channel: cleanChannel, user: lowerUsername }, 'Error adding message to context');
            });

            // 2. Process commands (but !translate stop was handled above)
            let wasTranslateCommand = message.trim().toLowerCase().startsWith('!translate '); // Keep this simple check
            
            // Check if it was a geo command - prevents processing as guess
            let wasGeoCommand = message.trim().toLowerCase().startsWith('!geo');
            let wasTriviaCommand = message.trim().toLowerCase().startsWith('!trivia');
            let wasRiddleCommand = message.trim().toLowerCase().startsWith('!riddle');
            
            // Debug log for geo command
            if (wasGeoCommand) {
                logger.debug({ 
                    message, 
                    channel: cleanChannel, 
                    user: lowerUsername 
                }, '!geo command detected in message handler');
            }
            
            processCommand(cleanChannel, tags, message).catch(err => {
                logger.error({ 
                    err, 
                    details: err.message, 
                    stack: err.stack, 
                    channel: cleanChannel, 
                    user: lowerUsername, 
                    commandAttempt: message 
                }, 'Error caught directly from processCommand call');
            });

            // --- Check for Game Guesses/Answers FIRST ---
            // Only if it wasn't a command and wasn't handled by stop/translate
            if (!message.startsWith('!') && !isStopRequest) {
                // Pass potential guess to the GeoGame Manager
                geoManager.processPotentialGuess(cleanChannel, lowerUsername, displayName, message);
                // Also pass potential answer to the Trivia Game Manager
                triviaManager.processPotentialAnswer(cleanChannel, lowerUsername, displayName, message);
                riddleManager.processPotentialAnswer(cleanChannel, lowerUsername, displayName, message);
                // We don't necessarily 'return' here, as a guess or answer might *also* mention the bot
            }

            // --- Automatic Translation Logic ---
            const userState = contextManager.getUserTranslationState(cleanChannel, lowerUsername);
            // Translate only if: enabled, NOT the !translate command itself, AND NOT a !translate stop command
            if (userState?.isTranslating && userState.targetLanguage && !wasTranslateCommand && !isStopRequest) {
                (async () => {
                    logger.debug(`[${cleanChannel}] Translating message from ${lowerUsername} to ${userState.targetLanguage}`);
                    try {
                        const translatedText = await translateText(message, userState.targetLanguage);
                        if (translatedText) {
                            const reply = `🌐💬 @${displayName}: ${translatedText}`;
                            enqueueMessage(channel, reply);
                        } else {
                            logger.warn(`[${cleanChannel}] Failed to translate message for ${lowerUsername}`);
                        }
                    } catch (err) {
                        logger.error({ err, channel: cleanChannel, user: lowerUsername }, 'Error during automatic translation.');
                    }
                })();
                return;
            }

            // --- Mention Check ---
            // Check only if: not self, not any game command, not translate cmd, not stop request, not already translated
            if (!self && !wasTranslateCommand && !wasGeoCommand && !wasTriviaCommand && !wasRiddleCommand && !isStopRequest) {
                const mentionPrefix = `@${config.twitch.username.toLowerCase()}`;
                if (message.toLowerCase().startsWith(mentionPrefix)) {
                    const userMessageContent = message.substring(mentionPrefix.length).trim();
                    if (userMessageContent) {
                        logger.info({ channel: cleanChannel, user: lowerUsername }, 'Bot mentioned, triggering standard LLM query...');
                        handleStandardLlmQuery(channel, cleanChannel, displayName, lowerUsername, userMessageContent, "mention")
                            .catch(err => logger.error({ err }, "Error in async mention handler call"));
                    } else {
                        logger.debug(`Ignoring empty mention for ${displayName} in ${cleanChannel}`);
                    }
                }
            }
        }); // End of message handler

        // Add other basic listeners
        ircClient.on('connecting', (address, port) => { logger.info(`Connecting to Twitch IRC at ${address}:${port}...`); });
        ircClient.on('logon', () => { logger.info('Successfully logged on to Twitch IRC.'); });
        ircClient.on('join', (channel, username, self) => { if (self) { logger.info(`Joined channel: ${channel}`); } });

        // --- Connect IRC Client ---
        logger.info('Connecting Twitch IRC Client...');
        await connectIrcClient(); // Use connectIrcClient

        // --- Setup Health Check Server ---
        const PORT = process.env.PORT || 8080;
        global.healthServer = http.createServer((req, res) => {
            // Basic health check endpoint
            if (req.url === '/healthz' || req.url === '/') {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('OK');
            } else {
                res.writeHead(404);
                res.end();
            }
        });

        global.healthServer.listen(PORT, () => {
            logger.info(`Health check server listening on port ${PORT}`);
        });

        // --- Post-Connection Logging ---
        logger.info('ChatSage components initialized and event listeners attached.');
        // Log the *actual* channels joined
        logger.info(`Ready and listening to channels: ${ircClient.getChannels().join(', ')}`);

    } catch (error) {
        logger.fatal({ err: error }, 'Fatal error during ChatSage initialization.');
        process.exit(1);
    }
}

// --- Graceful Shutdown Handling ---
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Add uncaught exception handler for graceful shutdown on critical errors
process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught Exception thrown - initiating graceful shutdown');
    gracefulShutdown('UNCAUGHT_EXCEPTION').catch(err => {
        logger.error({ err }, 'Error during graceful shutdown from uncaught exception');
        process.exit(1);
    });
});

// --- Start the Application ---
main();

// --- Optional: Unhandled Rejection Handling ---
process.on('unhandledRejection', (reason, promise) => {
    logger.error({ reason, promise }, 'Unhandled Rejection at Promise');
});