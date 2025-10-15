import config from './config/index.js';
import logger from './lib/logger.js';
import http from 'http';
import { eventSubHandler, handleKeepAlivePing, cleanupKeepAliveTasks, initializeActiveStreamsFromPoller, markLazyConnectInitialized } from './components/twitch/eventsub.js';
// Import Secret Manager initializer and getSecretValue
import { initializeSecretManager, validateSecretManager, getSecretManagerStatus } from './lib/secretManager.js';

// Add periodic Secret Manager status logging
setInterval(() => {
    logger.debug('Secret Manager Status Check:', getSecretManagerStatus());
}, 60000); // Every minute
import { createIrcClient, connectIrcClient, getIrcClient } from './components/twitch/ircClient.js';
import { initializeHelixClient, getHelixClient } from './components/twitch/helixClient.js';
import { initializeGeminiClient } from './components/llm/geminiClient.js';
import { translateText } from './lib/translationUtils.js';
import { initializeContextManager, getContextManager } from './components/context/contextManager.js';
import { initializeCommandProcessor, processMessage as processCommand } from './components/commands/commandProcessor.js';

import { startStreamInfoPolling, stopStreamInfoPolling } from './components/twitch/streamInfoPoller.js';
import { initializeIrcSender, enqueueMessage, clearMessageQueue } from './lib/ircSender.js';
import { handleStandardLlmQuery } from './components/llm/llmUtils.js';
import { initializeGeoGameManager, getGeoGameManager } from './components/geo/geoGameManager.js';
import { initializeStorage } from './components/geo/geoStorage.js';
import { initializeTriviaGameManager, getTriviaGameManager } from './components/trivia/triviaGameManager.js';
import { initializeStorage as initializeTriviaStorage } from './components/trivia/triviaStorage.js';
import { initializeChannelManager, getActiveManagedChannels, syncManagedChannelsWithIrc, listenForChannelChanges, isChannelAllowed } from './components/twitch/channelManager.js';
import { initializeLanguageStorage } from './components/context/languageStorage.js';
import { initializeAutoChatStorage } from './components/context/autoChatStorage.js';
import { startAutoChatManager, notifyUserMessage } from './components/autoChat/autoChatManager.js';
import { initializeCommandStateManager, shutdownCommandStateManager } from './components/context/commandStateManager.js';
import { initializeRiddleStorage } from './components/riddle/riddleStorage.js';
import { initializeRiddleGameManager, getRiddleGameManager } from './components/riddle/riddleGameManager.js';
import { startAdSchedulePoller, stopAdSchedulePoller } from './components/twitch/adSchedulePoller.js';

let streamInfoIntervalId = null;
let ircClient = null;
let channelChangeListener = null;
let isFullyInitialized = false;
let channelSyncIntervalId = null;

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
async function gracefulShutdown(_signal) {
    
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
    
    // Clean up command state manager
    try {
        logger.info('Shutting down command state manager...');
        shutdownCommandStateManager();
    } catch (error) {
        logger.error({ err: error }, 'Error shutting down command state manager during shutdown.');
    }
    
    // Clear polling interval immediately
    if (streamInfoIntervalId) {
        stopStreamInfoPolling(streamInfoIntervalId);
        logger.info('Stream info polling stopped.');
    }
    // Clear channel sync interval if set
    if (channelSyncIntervalId) {
        clearInterval(channelSyncIntervalId);
        channelSyncIntervalId = null;
        logger.info('Channel sync interval cleared.');
    }
    // Stop Ad Schedule Poller if running
    try {
        stopAdSchedulePoller();
        logger.info('Ad Schedule Poller stopped.');
    } catch (e) {
        logger.warn({ err: e }, 'Failed to stop Ad Schedule Poller during shutdown.');
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
 * Helper function to listen with port fallback in development.
 */
async function listenWithFallback(server, port) {
    const isDev = config.app.nodeEnv === 'development';
    let portToTry = port;
    for (let attempt = 0; attempt < (isDev ? 5 : 1); attempt++) {
        try {
            await new Promise((resolve, reject) => {
                const onError = (err) => {
                    server.off('listening', onListening);
                    reject(err);
                };
                const onListening = () => {
                    server.off('error', onError);
                    resolve();
                };
                server.once('error', onError);
                server.once('listening', onListening);
                server.listen(portToTry);
            });
            logger.info(`Health check server listening on port ${portToTry}`);
            return portToTry;
        } catch (err) {
            if (isDev && err && err.code === 'EADDRINUSE') {
                logger.warn(`Port ${portToTry} in use. Trying ${portToTry + 1}...`);
                portToTry += 1;
                continue;
            }
            throw err;
        }
    }
    throw new Error('Failed to bind health server to an available port after several attempts.');
}

/**
 * Main application function.
 */
async function main() {
    try {
        logger.info(`Starting ChatSage v${process.env.npm_package_version || '1.0.0'}...`);
        logger.info(`Node Env: ${config.app.nodeEnv}, Log Level: ${config.app.logLevel}`);

        // --- Start HTTP server EARLY so Cloud Run sees the container as ready ---
        const desiredPort = parseInt(process.env.PORT || process.env.port || 8080, 10);
        if (!global.healthServer) {
            global.healthServer = http.createServer(async (req, res) => {
                // EventSub webhook endpoint
                if (req.method === 'POST' && req.url === '/twitch/event') {
                    const chunks = [];
                    req.on('data', c => chunks.push(c));
                    req.on('end', () => eventSubHandler(req, res, Buffer.concat(chunks)));
                    return;
                }

                // Keep-alive ping endpoint (called by Cloud Tasks)
                if (req.method === 'POST' && req.url === '/keep-alive') {
                    try {
                        await handleKeepAlivePing();
                        res.writeHead(200, { 'Content-Type': 'text/plain' });
                        res.end('OK');
                    } catch (error) {
                        logger.error({ err: error }, 'Error handling keep-alive ping');
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('Internal Server Error');
                    }
                    return;
                }

                // Health check endpoints (respond quickly)
                if ((req.method === 'GET' || req.method === 'HEAD') && (req.url === '/healthz' || req.url === '/')) {
                    const status = getSecretManagerStatus();
                    const healthStatus = status.initialized ? 'OK' : 'DEGRADED';
                    const responseText = req.method === 'HEAD' ? undefined : `${healthStatus} - Secret Manager: ${status.mode}`;

                    res.writeHead(status.initialized ? 200 : 503, {
                        'Content-Type': 'text/plain',
                        'X-Secret-Manager-Status': status.mode,
                        'X-Secret-Manager-Initialized': status.initialized.toString()
                    });
                    res.end(responseText);
                    return;
                }

                // Startup readiness check - only returns 200 when fully initialized
                if ((req.method === 'GET' || req.method === 'HEAD') && req.url === '/startupz') {
                    if (isFullyInitialized) {
                        res.writeHead(200, { 'Content-Type': 'text/plain' });
                        res.end(req.method === 'HEAD' ? undefined : 'Ready');
                    } else {
                        res.writeHead(503, { 'Content-Type': 'text/plain' });
                        res.end(req.method === 'HEAD' ? undefined : 'Not Ready');
                    }
                    return;
                }

                // 404 for everything else
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
            });
            await listenWithFallback(global.healthServer, desiredPort);
        }

        // --- Initialize Core Components (Order matters) ---
        
        // 1. Initialize Secret Manager FIRST
        logger.info('Initializing Secret Manager...');
        initializeSecretManager();

        // 2. Validate Secret Manager is working
        logger.info('Validating Secret Manager initialization...');
        if (!validateSecretManager()) {
            logger.fatal('Secret Manager validation failed. Cannot continue safely.');
            process.exit(1);
        }

        // 3. Initialize Channel Manager and load channels from Firestore
        logger.info('Initializing Channel Manager...');
        await initializeChannelManager();
        
        // --- Load Twitch Channels ---
        // Use env-based channels locally (development) and Firestore when deployed on Cloud Run.
        const isCloudRun = !!(process.env.K_SERVICE || process.env.K_REVISION || process.env.K_CONFIGURATION);
        if (!isCloudRun && config.app.nodeEnv === 'development') {
            logger.info('Local development detected. Using TWITCH_CHANNELS from .env');
            const envChannels = (process.env.TWITCH_CHANNELS || '')
                .split(',')
                .map(ch => ch.trim().toLowerCase())
                .filter(Boolean);
            if (envChannels.length === 0) {
                logger.fatal('TWITCH_CHANNELS is empty or not set in .env for development. Please set it.');
                process.exit(1);
            }
            config.twitch.channels = envChannels;
            logger.info(`Loaded ${config.twitch.channels.length} channels from .env: [${config.twitch.channels.join(', ')}]`);
        } else {
            logger.info('Cloud environment detected or not development. Loading channels from Firestore.');
            const managedChannels = await getActiveManagedChannels();
            if (managedChannels && managedChannels.length > 0) {
                config.twitch.channels = managedChannels.map(ch => ch.toLowerCase());
                logger.info(`Loaded ${config.twitch.channels.length} channels from Firestore.`);
            } else {
                logger.fatal('No active channels found in Firestore managedChannels collection. Cannot proceed.');
                process.exit(1);
            }
        }
        // Ensure channels are populated before proceeding
        if (!config.twitch.channels || config.twitch.channels.length === 0) {
            logger.fatal('FATAL: No Twitch channels configured to join. Exiting.');
            process.exit(1);
        }

        // 4. Other initializations that might need secrets
        logger.info('Initializing Firebase Storage...');
        await initializeStorage();

        logger.info('Initializing Trivia Storage...');
        await initializeTriviaStorage();

        logger.info('Initializing Riddle Storage...');
        await initializeRiddleStorage();

        logger.info('Initializing Language Storage...');
        await initializeLanguageStorage();

        logger.info('Initializing Auto-Chat Storage...');
        await initializeAutoChatStorage();

        logger.info('Initializing Command State Manager...');
        await initializeCommandStateManager();

        logger.info('Initializing Gemini Client...');
        initializeGeminiClient(config.gemini);

        logger.info('Initializing Twitch Helix Client...');
        await initializeHelixClient(config.twitch);

        logger.info('Initializing Context Manager...');
        await initializeContextManager(config.twitch.channels);

        logger.info('Cleaning up any orphaned keep-alive tasks...');
        await cleanupKeepAliveTasks();

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

        // Start Ad Schedule Poller before IRC connects so we always log its activity
        try {
            await startAdSchedulePoller();
            logger.info('Ad Schedule Poller started (pre-IRC).');
        } catch (err) {
            logger.error({ err }, 'Failed to start Ad Schedule Poller (pre-IRC)');
        }

        // --- Get Instances needed before IRC connection ---
        const contextManager = getContextManager();
        const helixClient = getHelixClient();
        const geoManager = getGeoGameManager();
        const triviaManager = getTriviaGameManager();

        // Log Secret Manager status for monitoring
        logger.info('Secret Manager Status:', getSecretManagerStatus());
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
                if (!channelSyncIntervalId) {
                    channelSyncIntervalId = setInterval(async () => {
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
                    logger.info(`Scheduled channel sync every ${CHANNEL_SYNC_INTERVAL_MS / 60000} minutes.`);
                } else {
                    logger.warn('Channel sync interval already scheduled; skipping re-schedule.');
                }
            } else {
                logger.info('Development mode: Skipping Firestore channel listener setup and periodic sync.');
            }
            // --- End Conditional Syncing/Listening ---
            
            // 3. Start stream info polling (skip if already started in LAZY_CONNECT mode)
            if (!streamInfoIntervalId) {
                logger.info(`Starting stream info polling every ${config.app.streamInfoFetchIntervalMs / 1000}s...`);
                try {
                    // Await first poll to complete so context manager is populated
                    streamInfoIntervalId = await startStreamInfoPolling(
                        config.twitch.channels,
                        config.app.streamInfoFetchIntervalMs,
                        helixClient, // Pass already retrieved instance
                        contextManager // Pass already retrieved instance
                    );
                    logger.info('Stream info polling first cycle complete');
                } catch (err) {
                    logger.error({ err }, 'Failed to start stream info polling');
                }
            } else {
                logger.info('Stream info polling already running (started in LAZY_CONNECT mode)');
            }

            // Start Auto-Chat manager after polling begins
            try {
                await startAutoChatManager();
                logger.info('Auto-Chat Manager started.');
            } catch (err) {
                logger.error({ err }, 'Failed to start Auto-Chat Manager');
            }
            try {
                await startAdSchedulePoller();
                logger.info('Ad Schedule Poller started.');
            } catch (err) {
                logger.error({ err }, 'Failed to start Ad Schedule Poller');
            }

            // After stream polling completes first cycle, check for streams that are already live
            try {
                await initializeActiveStreamsFromPoller();
                // Mark as fully initialized after all setup is complete
                isFullyInitialized = true;
                logger.info('Bot is now fully initialized and ready to handle traffic');
            } catch (error) {
                logger.error({ err: error }, 'Error initializing active streams from poller');
                isFullyInitialized = true; // Mark as initialized anyway
            }
        });

        ircClient.on('disconnected', (reason) => {
            logger.warn(`Disconnected from Twitch IRC: ${reason || 'Unknown reason'}`);
            stopStreamInfoPolling(streamInfoIntervalId);
            try { stopAdSchedulePoller(); } catch (e) { /* ignore */ }
            if (channelSyncIntervalId) {
                clearInterval(channelSyncIntervalId);
                channelSyncIntervalId = null;
                logger.info('Cleared channel sync interval on disconnect.');
            }
            
            // Clean up Firestore listener ONLY if it was started
            if (config.app.nodeEnv !== 'development' && channelChangeListener) {
                logger.info('Cleaning up channel change listener on disconnect...');
                channelChangeListener();
                channelChangeListener = null;
            }
        });

        // --- MESSAGE HANDLER ---
        ircClient.on('message', async (channel, tags, message, self) => {
            // Robust self/bot message guard: skip any message authored by the bot account
            const botUsername = config.twitch.username?.toLowerCase?.() || '';
            const author = (tags.username || '').toLowerCase();
            if (self || (botUsername && author === botUsername)) {
                // Add self message to context ONLY
                getContextManager().addMessage(channel.substring(1), tags.username, message, tags).catch(err => {
                    logger.error({ err, channel: channel.substring(1), user: tags.username }, 'Error adding self message to context');
                });
                return; // Prevent further processing for self messages
            }

            const cleanChannel = channel.substring(1);

            // Enforce allow-list: if channel not in configured list (dev) or not allowed per Firestore (prod), ignore
            try {
                const isConfiguredChannel = Array.isArray(config.twitch.channels) && config.twitch.channels.map(c => c.toLowerCase()).includes(cleanChannel.toLowerCase());
                let allowed = isConfiguredChannel;
                if (!allowed && config.app.nodeEnv !== 'development') {
                    allowed = await isChannelAllowed(cleanChannel);
                }
                if (!allowed) {
                    logger.warn(`[BotJS] Received message in disallowed channel ${cleanChannel}. Ignoring.`);
                    return;
                }
            } catch (allowErr) {
                logger.error({ err: allowErr, channel: cleanChannel }, '[BotJS] Error checking allow-list. Ignoring message as a safety measure.');
                return;
            }
            const lowerUsername = tags.username.toLowerCase();
            const displayName = tags['display-name'] || tags.username;
            const contextManager = getContextManager();
            const isModOrBroadcaster = isPrivilegedUser(tags, cleanChannel);
            const riddleManager = getRiddleGameManager(); // Ensure this is available

            // --- Check for pending report responses (Riddle, Trivia, Geo) ---
            // IMPORTANT: We only handle pending reports here and return early if found.
            // If no pending report exists, we let the message continue to be processed
            // as a potential game answer (trivia/riddle/geo).
            if (/^\d+$/.test(message.trim())) {
                logger.debug(`[BotJS] Numeric message "${message.trim()}" from ${lowerUsername} in ${cleanChannel}. Checking for pending report.`);

                // Try Riddle first
                let reportFinalizationResult = await riddleManager.finalizeReportWithRoundNumber(cleanChannel, lowerUsername, message.trim());
                if (reportFinalizationResult.message !== null) {
                    enqueueMessage(channel, reportFinalizationResult.message);
                    logger.info(`[BotJS] Numeric message from ${lowerUsername} was processed by Riddle finalizeReportWithRoundNumber. Result message: "${reportFinalizationResult.message}"`);
                    contextManager.addMessage(cleanChannel, lowerUsername, message, tags).catch(err => {
                        logger.error({ err, channel: cleanChannel, user: lowerUsername }, 'Error adding numeric report response to context');
                    });
                    return; // Report processed, stop here
                }

                // Try Trivia next
                reportFinalizationResult = await triviaManager.finalizeReportWithRoundNumber(cleanChannel, lowerUsername, message.trim());
                if (reportFinalizationResult.message !== null) {
                    enqueueMessage(channel, reportFinalizationResult.message);
                    logger.info(`[BotJS] Numeric message from ${lowerUsername} was processed by Trivia finalizeReportWithRoundNumber. Result message: "${reportFinalizationResult.message}"`);
                    contextManager.addMessage(cleanChannel, lowerUsername, message, tags).catch(err => {
                        logger.error({ err, channel: cleanChannel, user: lowerUsername }, 'Error adding numeric report response to context');
                    });
                    return; // Report processed, stop here
                }

                // Try Geo last
                reportFinalizationResult = await geoManager.finalizeReportWithRoundNumber(cleanChannel, lowerUsername, message.trim());
                if (reportFinalizationResult.message !== null) {
                    enqueueMessage(channel, reportFinalizationResult.message);
                    logger.info(`[BotJS] Numeric message from ${lowerUsername} was processed by Geo finalizeReportWithRoundNumber. Result message: "${reportFinalizationResult.message}"`);
                    contextManager.addMessage(cleanChannel, lowerUsername, message, tags).catch(err => {
                        logger.error({ err, channel: cleanChannel, user: lowerUsername }, 'Error adding numeric report response to context');
                    });
                    return; // Report processed, stop here
                }

                // If we reach here, no pending report was found. The numeric message will
                // continue to be processed below as a potential game answer.
                logger.debug(`[BotJS] Numeric message "${message.trim()}" from ${lowerUsername}: no pending report found. Continuing to game answer processing.`);
            }
            // --- END: Check for pending report responses ---

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
                    const replyToId = tags?.id || tags?.['message-id'] || null;
                    enqueueMessage(channel, `Okay, stopped translations globally for ${count} user(s).`, { replyToId });
                } else {
                    // Check permission if target is not self
                    if (targetUserForStop !== lowerUsername && !isModOrBroadcaster) {
                        enqueueMessage(channel, `Only mods/broadcaster can stop translation for others.`, { replyToId: tags?.id || tags?.['message-id'] || null });
                    } else {
                        const wasStopped = contextManager.disableUserTranslation(cleanChannel, targetUserForStop);
                        const replyToId = tags?.id || tags?.['message-id'] || null;
                        if (targetUserForStop === lowerUsername) { // Message for self stop
                            enqueueMessage(channel, wasStopped ? `Translation stopped.` : `Translation was already off.`, { replyToId });
                        } else { // Message for mod stopping someone else
                            enqueueMessage(channel, wasStopped ? `Stopped translation for ${targetUserForStop}.` : `Translation was already off for ${targetUserForStop}.`, { replyToId });
                        }
                    }
                }
                return; // Stop processing this message further
            }

            // 1. Add message to context
            contextManager.addMessage(cleanChannel, lowerUsername, message, tags).catch(err => {
                logger.error({ err, channel: cleanChannel, user: lowerUsername }, 'Error adding message to context');
            });
            // Notify AutoChatManager about activity
            try { notifyUserMessage(cleanChannel, Date.now()); } catch (e) { /* ignore */ }

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
                            const reply = `🌐💬 ${translatedText}`;
                            const replyToId = tags?.id || tags?.['message-id'] || null;
                            enqueueMessage(channel, reply, { replyToId });
                        } else {
                            logger.warn(`[${cleanChannel}] Failed to translate message for ${lowerUsername}`);
                        }
                    } catch (err) {
                        logger.error({ err, channel: cleanChannel, user: lowerUsername }, 'Error during automatic translation.');
                    }
                })();
                return;
            }

            // --- Mention or Reply-to-Bot Check ---
            // Trigger chat when the message mentions the bot OR is a native Twitch reply to the bot
            if (!self && !wasTranslateCommand && !wasGeoCommand && !wasTriviaCommand && !wasRiddleCommand && !isStopRequest) {
                const botLower = config.twitch.username.toLowerCase();
                const mentionPrefix = `@${botLower}`;
                const lowerMsg = message.toLowerCase();
                const isMention = lowerMsg.startsWith(mentionPrefix);
                const isReplyToBot = (tags && tags['reply-parent-user-login'] && tags['reply-parent-user-login'].toLowerCase() === botLower) || false;

                if ((isMention || isReplyToBot) && !message.startsWith('!')) {
                    let userMessageContent = message;
                    if (isMention) {
                        userMessageContent = message.substring(mentionPrefix.length).trim();
                    }
                    if (userMessageContent) {
                        const triggerType = isReplyToBot ? 'reply' : 'mention';
                        logger.info({ channel: cleanChannel, user: lowerUsername, trigger: triggerType }, 'Bot interaction detected, triggering standard LLM query...');
                        const replyToId = tags?.id || tags?.['message-id'] || null;
                        handleStandardLlmQuery(channel, cleanChannel, displayName, lowerUsername, userMessageContent, triggerType, replyToId)
                            .catch(err => logger.error({ err }, 'Error in async interaction handler call'));
                    } else {
                        logger.debug(`Ignoring empty mention/reply from ${displayName} in ${cleanChannel}`);
                    }
                }
            }
        }); // End of message handler

        // Add other basic listeners
        ircClient.on('connecting', (address, port) => { logger.info(`Connecting to Twitch IRC at ${address}:${port}...`); });
        ircClient.on('logon', () => { logger.info('Successfully logged on to Twitch IRC.'); });
        ircClient.on('join', (channel, username, self) => { if (self) { logger.info(`Joined channel: ${channel}`); } });

        // --- Connect IRC Client (conditionally based on LAZY_CONNECT) ---
        const isLazyConnect = process.env.LAZY_CONNECT === '1' || process.env.LAZY_CONNECT === 'true';
        if (!isLazyConnect) {
            logger.info('Connecting Twitch IRC Client...');
            await connectIrcClient(); // Use connectIrcClient

            // WORKAROUND: tmi.js sometimes doesn't fire 'connected' event reliably
            // Check if we're actually connected and manually trigger initialization if needed
            setTimeout(async () => {
                if (ircClient.readyState() === 'OPEN' && !isFullyInitialized) {
                    logger.warn('IRC client is connected but \'connected\' event never fired. Manually triggering initialization...');
                    // Manually fire the connected handler logic
                    try {
                        logger.info('(Manual trigger) Starting stream info polling...');
                        streamInfoIntervalId = await startStreamInfoPolling(
                            config.twitch.channels,
                            config.app.streamInfoFetchIntervalMs,
                            helixClient,
                            contextManager
                        );
                        logger.info('(Manual trigger) Stream polling first cycle complete');

                        await startAutoChatManager();
                        logger.info('(Manual trigger) Auto-Chat Manager started.');

                        await initializeActiveStreamsFromPoller();
                        isFullyInitialized = true;
                        logger.info('(Manual trigger) Bot is now fully initialized');
                    } catch (err) {
                        logger.error({ err }, 'Failed during manual initialization trigger');
                    }
                }
            }, 5000); // Wait 5 seconds after connect() resolves
        } else {
            logger.info('LAZY_CONNECT enabled - IRC client will connect on first EventSub trigger');

            // In LAZY_CONNECT mode, start stream poller immediately to detect already-live streams.
            // This handles the case where bot is deployed/restarted during a live stream (rolling updates).
            // EventSub only fires when streams GO online, not when they're already online.
            logger.info('[LAZY_CONNECT] Starting stream poller to detect already-live streams...');
            try {
                // Await first poll to complete so context manager is populated with current stream states
                streamInfoIntervalId = await startStreamInfoPolling(
                    config.twitch.channels,
                    config.app.streamInfoFetchIntervalMs,
                    helixClient,
                    contextManager
                );
                logger.info('[LAZY_CONNECT] Stream poller first cycle complete');
            } catch (err) {
                logger.error({ err }, '[LAZY_CONNECT] Failed to start stream poller');
            }

            // Start Auto-Chat manager and Ad Schedule Poller
            try {
                await startAutoChatManager();
                logger.info('[LAZY_CONNECT] Auto-Chat Manager started.');
            } catch (err) {
                logger.error({ err }, '[LAZY_CONNECT] Failed to start Auto-Chat Manager');
            }
            try {
                await startAdSchedulePoller();
                logger.info('[LAZY_CONNECT] Ad Schedule Poller started.');
            } catch (err) {
                logger.error({ err }, '[LAZY_CONNECT] Failed to start Ad Schedule Poller');
            }

            // Set up Firestore channel listener in LAZY_CONNECT mode (even without IRC connection)
            if (config.app.nodeEnv !== 'development') {
                logger.info('[LAZY_CONNECT] Setting up Firestore channel listener...');
                if (!channelChangeListener) {
                    channelChangeListener = listenForChannelChanges(ircClient);
                    logger.info('[LAZY_CONNECT] ✓ Firestore channel listener active');
                }
            }

            // Mark lazy connect as initialized to prevent EventSub from re-initializing
            markLazyConnectInitialized();

            // Check for already-live streams now that poller has completed first cycle
            try {
                logger.info('[LAZY_CONNECT] Checking for already-live streams...');
                await initializeActiveStreamsFromPoller();
                isFullyInitialized = true;
                logger.info('[LAZY_CONNECT] ✓ Bot fully initialized');
            } catch (error) {
                logger.error({ err: error }, '[LAZY_CONNECT] Error checking for live streams');
                isFullyInitialized = true; // Mark as initialized anyway
            }

            logger.info('Bot is ready in lazy connect mode - will detect live streams or wait for EventSub');
        }

        // HTTP server already started above; endpoints are available during initialization

        // --- Post-Connection Logging ---
        logger.info('ChatSage components initialized and event listeners attached.');
        // Log the *actual* channels joined
        logger.info(`Ready and listening to channels: ${ircClient.getChannels().join(', ')}`);

        // Ad-break subscription reconciliation is handled by the web UI after setting changes.

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
