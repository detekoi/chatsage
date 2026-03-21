import config from './config/index.js';
import { initEmoteDescriber, initEmoteDescriptionStore } from './lib/geminiEmoteDescriber.js';
import logger from './lib/logger.js';
import { getSecretManagerStatus } from './lib/secretManager.js';
import { getHelixClient } from './components/twitch/helixClient.js';
import { getContextManager } from './components/context/contextManager.js';
import { clearMessageQueue } from './lib/ircSender.js';
import { getGeoGameManager } from './components/geo/geoGameManager.js';
import { getTriviaGameManager } from './components/trivia/triviaGameManager.js';
import { getRiddleGameManager } from './components/riddle/riddleGameManager.js';
import { notifyUserMessage } from './components/autoChat/autoChatManager.js';
import { shutdownCommandStateManager } from './components/context/commandStateManager.js';
import LifecycleManager from './services/LifecycleManager.js';

// Extracted modules
import { createHealthServer, closeHealthServer } from './server/healthServer.js';
import { initializeAllComponents } from './initialization/initComponents.js';
import { SECRET_MANAGER_STATUS_LOG_INTERVAL_MS, SHUTDOWN_FORCE_EXIT_TIMEOUT_MS } from './constants/botConstants.js';

// Add periodic Secret Manager status logging
setInterval(() => {
    logger.debug('Secret Manager Status Check:', getSecretManagerStatus());
}, SECRET_MANAGER_STATUS_LOG_INTERVAL_MS);

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

    // Clean up command state manager
    try {
        logger.info('Shutting down command state manager...');
        shutdownCommandStateManager();
    } catch (error) {
        logger.error({ err: error }, 'Error shutting down command state manager during shutdown.');
    }

    // Clear message queue
    clearMessageQueue();
    logger.info('Message queue cleared.');

    // Run all shutdown tasks in parallel and wait for them to finish
    await Promise.allSettled(shutdownTasks);

    // Safety timeout in case something hangs
    const forceExitTimeout = setTimeout(() => {
        logger.error('Force exiting after timeout...');
        process.exit(1);
    }, SHUTDOWN_FORCE_EXIT_TIMEOUT_MS);

    logger.info('WildcatSage shutdown complete.');
    clearTimeout(forceExitTimeout);
    process.exit(0);
}

/**
 * Main application function.
 */
async function main() {
    try {
        logger.info(`Starting WildcatSage v${process.env.npm_package_version || '1.0.0'}...`);
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

        // Signal to EventSub handler that all components are ready
        const { markEventSubReady } = await import('./components/twitch/eventsub.js');
        markEventSubReady();

        // --- Initialize Gemini Emote Describer ---
        initEmoteDescriber(config.gemini?.apiKey || process.env.GEMINI_API_KEY);
        initEmoteDescriptionStore();

        // --- Get Instances needed for setup ---
        const contextManager = getContextManager();
        const helixClient = getHelixClient();

        // Log Secret Manager status for monitoring
        logger.info('Secret Manager Status:', getSecretManagerStatus());

        // --- Subscribe to EventSub for chat messages ---
        // In dev mode, skip subscribing all managed channels — only TWITCH_CHANNELS
        // are subscribed (after the lifecycle manager starts, see below).
        // In production, subscribe all active Firestore channels.
        if (config.app.nodeEnv !== 'development') {
            logger.info('Setting up EventSub subscriptions for chat messages...');
            try {
                const { subscribeAllManagedChannels } = await import('./components/twitch/twitchSubs.js');
                const subResults = await subscribeAllManagedChannels();
                logger.info({
                    successful: subResults.successful?.length || 0,
                    failed: subResults.failed?.length || 0,
                    total: subResults.total || 0
                }, 'EventSub subscription setup complete');
            } catch (error) {
                logger.error({ err: error }, 'Error setting up EventSub subscriptions (non-fatal, will retry on channel changes)');
            }
        }

        // --- Start Lifecycle Manager ---
        // LifecycleManager.startMonitoring() sets up the Firestore channel change listener internally.
        // This MUST run before the dev-mode subscription code below, because the
        // Firestore listener's initial snapshot calls removeAllowedChannel() for
        // inactive channels — if we addAllowedChannel() before this, it gets undone.
        logger.info('Initializing Lifecycle Manager...');
        const lifecycle = LifecycleManager.get();
        await lifecycle.startMonitoring();

        // --- Dev mode: subscribe test channels from TWITCH_CHANNELS env var ---
        // Test channels (e.g. parfaittest) must stay isActive:false in Firestore
        // to prevent the production bot from also subscribing. In local dev,
        // we subscribe them explicitly and add them to the allowlist.
        // This runs AFTER the lifecycle manager so the initial Firestore snapshot
        // doesn't undo the addAllowedChannel() call.
        if (config.app.nodeEnv === 'development' && config.twitch.channels.length > 0) {
            try {
                const { getUsersByLogin } = await import('./components/twitch/helixClient.js');
                const { subscribeStreamOnline, subscribeStreamOffline, subscribeChannelChatMessage } = await import('./components/twitch/twitchSubs.js');
                const { addAllowedChannel } = await import('./lib/allowList.js');
                logger.info({ channels: config.twitch.channels }, '[Dev] Subscribing TWITCH_CHANNELS to EventSub...');
                for (const channelName of config.twitch.channels) {
                    const users = await getUsersByLogin([channelName]);
                    const userId = users?.[0]?.id;
                    if (!userId) {
                        logger.warn({ channelName }, '[Dev] Could not resolve channel to user ID, skipping');
                        continue;
                    }
                    addAllowedChannel(channelName, userId);
                    await subscribeStreamOnline(userId);
                    await subscribeStreamOffline(userId);
                    await subscribeChannelChatMessage(userId);
                    logger.info({ channelName, userId }, '[Dev] EventSub subscriptions created for dev channel');
                }
            } catch (error) {
                logger.error({ err: error }, '[Dev] Error subscribing TWITCH_CHANNELS (non-fatal)');
            }
        }

        // --- Post-Connection Logging ---
        logger.info('WildcatSage components initialized and EventSub webhooks active.');
        logger.info('Lifecycle Manager is running. Chat messages received via EventSub, sent via Helix API.');

    } catch (error) {
        logger.fatal({ err: error }, 'Fatal error during WildcatSage initialization.');
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
