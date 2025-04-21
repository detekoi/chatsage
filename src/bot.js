import config from './config/index.js';
import logger from './lib/logger.js';
// Correct the import for ircClient functions
import { createIrcClient, connectIrcClient, getIrcClient } from './components/twitch/ircClient.js';
import { initializeHelixClient, getHelixClient } from './components/twitch/helixClient.js';
import { initializeGeminiClient, getGeminiClient } from './components/llm/geminiClient.js';
import { initializeContextManager, getContextManager } from './components/context/contextManager.js';
import { initializeCommandProcessor, processMessage as processCommand } from './components/commands/commandProcessor.js';
import { startStreamInfoPolling, stopStreamInfoPolling } from './components/twitch/streamInfoPoller.js';

let streamInfoIntervalId = null;

/**
 * Gracefully shuts down the application.
 */
async function gracefulShutdown(signal) {
    // ... (gracefulShutdown function remains the same) ...
    logger.info(`Received ${signal}. Shutting down StreamSage gracefully...`);
    stopStreamInfoPolling(streamInfoIntervalId);
    const ircClient = getIrcClient(); // Still uses getIrcClient
    if (ircClient && ircClient.readyState() === 'OPEN') {
        try {
            logger.info('Disconnecting from Twitch IRC...');
            await ircClient.disconnect();
            logger.info('Disconnected from Twitch IRC.');
        } catch (err) {
            logger.error({ err }, 'Error during IRC disconnect.');
        }
    }
    logger.info('StreamSage shutdown complete.');
    process.exit(0);
}

/**
 * Main application function.
 */
async function main() {
    try {
        logger.info(`Starting StreamSage v${process.env.npm_package_version || '1.0.0'}...`);
        logger.info(`Node Env: ${config.app.nodeEnv}, Log Level: ${config.app.logLevel}`);

        // --- Initialize Core Components (excluding IRC client creation/connection) ---
        logger.info('Initializing Gemini Client...');
        initializeGeminiClient(config.gemini);

        logger.info('Initializing Twitch Helix Client...');
        await initializeHelixClient(config.twitch);

        logger.info('Initializing Context Manager...');
        initializeContextManager();

        logger.info('Initializing Command Processor...');
        initializeCommandProcessor();

        // --- Get Instances needed before IRC connection ---
        const contextManager = getContextManager(); // Needed for listeners
        const helixClient = getHelixClient();       // Needed for listeners

        // --- Create IRC Client Instance ---
        logger.info('Creating Twitch IRC Client instance...');
        const ircClient = createIrcClient(config.twitch); // Use createIrcClient

        // --- Setup IRC Event Listeners BEFORE Connecting ---
        logger.debug('Attaching IRC event listeners...');

        ircClient.on('connected', (address, port) => {
            logger.info(`Successfully connected to Twitch IRC: ${address}:${port}`);
            logger.info(`Starting stream info polling every ${config.app.streamInfoFetchIntervalMs / 1000}s...`);
            // helixClient and contextManager are already available here
            streamInfoIntervalId = startStreamInfoPolling(
                config.twitch.channels,
                config.app.streamInfoFetchIntervalMs,
                helixClient,
                contextManager
            );
        });

        ircClient.on('disconnected', (reason) => {
            logger.warn(`Disconnected from Twitch IRC: ${reason || 'Unknown reason'}`);
            stopStreamInfoPolling(streamInfoIntervalId);
        });

        ircClient.on('message', (channel, tags, message, self) => {
            if (self) return;
            const cleanChannel = channel.substring(1);
            const username = tags['display-name'] || tags.username;

            contextManager.addMessage(cleanChannel, username, message, tags).catch(err => {
                logger.error({ err, channel: cleanChannel, user: username }, 'Error adding message to context');
            });

            processCommand(cleanChannel, tags, message).catch(err => {
                 logger.error({ err, channel: cleanChannel, user: username }, 'Error processing command');
            });

            // Placeholder LLM trigger
            if (message.toLowerCase().includes(`@${config.twitch.username.toLowerCase()}`)) {
                logger.info({ channel: cleanChannel, user: username }, 'Bot mentioned, considering LLM response...');
                // Add LLM call logic here later
            }
        });

        // Add other basic listeners if desired (optional here, could be in ircClient.js)
        ircClient.on('connecting', (address, port) => { logger.info(`Connecting to Twitch IRC at ${address}:${port}...`); });
        ircClient.on('logon', () => { logger.info('Successfully logged on to Twitch IRC.'); });
        ircClient.on('join', (channel, username, self) => { if (self) { logger.info(`Joined channel: ${channel}`); } });


        // --- Connect IRC Client ---
        logger.info('Connecting Twitch IRC Client...');
        await connectIrcClient(); // Use connectIrcClient

        // --- Post-Connection Logging ---
        logger.info('StreamSage components initialized and event listeners attached.');
        logger.info(`Ready and listening to channels: ${config.twitch.channels.join(', ')}`);

    } catch (error) {
        logger.fatal({ err: error }, 'Fatal error during StreamSage initialization.');
        process.exit(1);
    }
}

// --- Graceful Shutdown Handling ---
process.on('SIGTERM', () => gracefulShutdown('SIGTERM')); // Docker stop, Kubernetes termination
process.on('SIGINT', () => gracefulShutdown('SIGINT'));  // Ctrl+C

// --- Start the Application ---
main();

// --- Optional: Unhandled Rejection/Exception Handling ---
process.on('unhandledRejection', (reason, promise) => {
    logger.error({ reason, promise }, 'Unhandled Rejection at Promise');
    // Consider whether to crash or attempt recovery depending on the error
});

process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught Exception thrown');
    // It's generally recommended to exit after an uncaught exception
    process.exit(1);
});