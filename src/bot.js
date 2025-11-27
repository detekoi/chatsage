import config from './config/index.js';
import logger from './lib/logger.js';
import { getSecretManagerStatus } from './lib/secretManager.js';
import { createIrcClient, getIrcClient } from './components/twitch/ircClient.js';
import { getHelixClient } from './components/twitch/helixClient.js';
import { getContextManager } from './components/context/contextManager.js';
import { processMessage as processCommand } from './components/commands/commandProcessor.js';
import { clearMessageQueue } from './lib/ircSender.js';
import { getGeoGameManager } from './components/geo/geoGameManager.js';
import { getTriviaGameManager } from './components/trivia/triviaGameManager.js';
import { getRiddleGameManager } from './components/riddle/riddleGameManager.js';
import { isChannelAllowed } from './components/twitch/channelManager.js';
import { notifyUserMessage } from './components/autoChat/autoChatManager.js';
import { shutdownCommandStateManager } from './components/context/commandStateManager.js';
import LifecycleManager from './services/LifecycleManager.js';

// Extracted modules
import { createHealthServer, closeHealthServer } from './server/healthServer.js';
import { createIrcEventHandlers } from './components/twitch/ircEventHandlers.js';
import { initializeAllComponents } from './initialization/initComponents.js';
import {
    isPrivilegedUser,
    handlePendingReport,
    handleStopTranslation,
    handleAutoTranslation,
    handleBotMention,
    processGameGuesses
} from './handlers/messageHandlers.js';
import { SECRET_MANAGER_STATUS_LOG_INTERVAL_MS, SHUTDOWN_FORCE_EXIT_TIMEOUT_MS } from './constants/botConstants.js';

// Add periodic Secret Manager status logging
setInterval(() => {
    logger.debug('Secret Manager Status Check:', getSecretManagerStatus());
}, SECRET_MANAGER_STATUS_LOG_INTERVAL_MS);

// Application state
let ircClient = null;
let channelChangeListener = null;
let channelSyncIntervalId = null;

/**
 * Gracefully shuts down the application.
 */
async function gracefulShutdown(signal) {
    logger.info(`Received ${signal} signal. Initiating graceful shutdown...`);
    const shutdownTasks = [];

    // Close health check server if it exists
    if (global.healthServer) {
        shutdownTasks.push(closeHealthServer(global.healthServer));
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

    // Note: LifecycleManager handles stopping pollers if we added a stop method,
    // but for now we can rely on process exit or add explicit stops here if needed.
    // The original code stopped them individually.
    // Since we are exiting, stopping intervals is less critical than closing connections.

    // Clear channel sync interval if set
    if (channelSyncIntervalId) {
        clearInterval(channelSyncIntervalId);
        channelSyncIntervalId = null;
        logger.info('Channel sync interval cleared.');
    }

    // Clear message queue before disconnecting
    clearMessageQueue();
    logger.info('Message queue cleared.');

    // Disconnect from Twitch IRC - get clientInstance safely
    let clientInstance = null;
    try {
        clientInstance = ircClient || getIrcClient();
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
    }, SHUTDOWN_FORCE_EXIT_TIMEOUT_MS);

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

        // --- Start HTTP server EARLY so Cloud Run sees the container as ready ---
        const desiredPort = parseInt(process.env.PORT || process.env.port || 8080, 10);
        if (!global.healthServer) {
            global.healthServer = await createHealthServer({
                port: desiredPort,
                isDev: config.app.nodeEnv === 'development',
                getIsFullyInitialized: () => LifecycleManager.get().isMonitoring // Use LifecycleManager state
            });
        }

        // --- Initialize All Components ---
        await initializeAllComponents();

        // --- Get Instances needed before IRC connection ---
        const contextManager = getContextManager();
        const helixClient = getHelixClient();
        const geoManager = getGeoGameManager();
        const triviaManager = getTriviaGameManager();
        const riddleManager = getRiddleGameManager();

        // Log Secret Manager status for monitoring
        logger.info('Secret Manager Status:', getSecretManagerStatus());

        // --- Create IRC Client Instance (now asynchronous) ---
        logger.info('Creating Twitch IRC Client instance (will fetch token)...');
        ircClient = await createIrcClient(config.twitch);

        // --- Setup IRC Event Handlers ---
        logger.debug('Attaching IRC event listeners...');

        const eventHandlers = createIrcEventHandlers({
            helixClient,
            contextManager,
            getChannelChangeListener: () => channelChangeListener,
            setChannelChangeListener: (value) => { channelChangeListener = value; },
            getChannelSyncIntervalId: () => channelSyncIntervalId,
            setChannelSyncIntervalId: (value) => { channelSyncIntervalId = value; }
        });

        // Attach event handlers to IRC client
        ircClient.on('connected', eventHandlers.onConnected);
        ircClient.on('disconnected', eventHandlers.onDisconnected);
        ircClient.on('connecting', eventHandlers.onConnecting);
        ircClient.on('logon', eventHandlers.onLogon);
        ircClient.on('join', eventHandlers.onJoin);

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
            const isModOrBroadcaster = isPrivilegedUser(tags, cleanChannel);

            // --- Check for pending report responses (Riddle, Trivia, Geo) ---
            const wasReportProcessed = await handlePendingReport({
                message,
                cleanChannel,
                lowerUsername,
                channel,
                tags,
                riddleManager,
                triviaManager,
                geoManager,
                contextManager
            });

            if (wasReportProcessed) {
                return; // Report processed, stop here
            }

            // --- Stop Translation Check ---
            const lowerMessage = message.toLowerCase().trim();
            const wasStopRequest = await handleStopTranslation({
                message,
                lowerMessage,
                cleanChannel,
                lowerUsername,
                channel,
                tags,
                isModOrBroadcaster,
                contextManager
            });

            if (wasStopRequest) {
                return; // Stop processing this message further
            }

            // 1. Add message to context
            contextManager.addMessage(cleanChannel, lowerUsername, message, tags).catch(err => {
                logger.error({ err, channel: cleanChannel, user: lowerUsername }, 'Error adding message to context');
            });

            // Notify AutoChatManager about activity
            try { notifyUserMessage(cleanChannel, Date.now()); } catch (e) { /* ignore */ }

            // 2. Process commands
            let wasTranslateCommand = message.trim().toLowerCase().startsWith('!translate ');
            let wasGeoCommand = message.trim().toLowerCase().startsWith('!geo');
            let wasTriviaCommand = message.trim().toLowerCase().startsWith('!trivia');
            let wasRiddleCommand = message.trim().toLowerCase().startsWith('!riddle');

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

            // --- Check for Game Guesses/Answers ---
            if (!message.startsWith('!') && !wasStopRequest) {
                processGameGuesses({
                    message,
                    cleanChannel,
                    lowerUsername,
                    displayName,
                    geoManager,
                    triviaManager,
                    riddleManager
                });
            }

            // --- Automatic Translation Logic ---
            const userState = contextManager.getUserTranslationState(cleanChannel, lowerUsername);
            const wasTranslated = await handleAutoTranslation({
                message,
                cleanChannel,
                lowerUsername,
                channel,
                tags,
                userState,
                wasTranslateCommand
            });

            if (wasTranslated) {
                return;
            }

            // --- Mention or Reply-to-Bot Check ---
            if (!self && !wasTranslateCommand && !wasGeoCommand && !wasTriviaCommand && !wasRiddleCommand && !wasStopRequest) {
                await handleBotMention({
                    message,
                    cleanChannel,
                    lowerUsername,
                    displayName,
                    channel,
                    tags
                });
            }
        }); // End of message handler

        // --- Start Lifecycle Manager ---
        logger.info('Initializing Lifecycle Manager...');
        const lifecycle = LifecycleManager.get();
        await lifecycle.startMonitoring();

        // --- Post-Connection Logging ---
        logger.info('ChatSage components initialized and event listeners attached.');
        logger.info('Lifecycle Manager is running. IRC connection will be managed automatically.');

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
