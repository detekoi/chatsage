import config from './config/index.js';
import logger from './lib/logger.js';
import { initializeIrcClient, getIrcClient } from './components/twitch/ircClient.js';
import { initializeHelixClient, getHelixClient } from './components/twitch/helixClient.js';
import { initializeGeminiClient, getGeminiClient } from './components/llm/geminiClient.js';
import { initializeContextManager, getContextManager } from './components/context/contextManager.js';
import { initializeCommandProcessor, processMessage as processCommand } from './components/commands/commandProcessor.js'; // Import processMessage
// Using 'as processCommand' to avoid potential naming conflicts if needed, and for clarity
import { startStreamInfoPolling, stopStreamInfoPolling } from './components/twitch/streamInfoPoller.js'; // Assuming a dedicated poller module

let streamInfoIntervalId = null; // To keep track of the polling timer

/**
 * Gracefully shuts down the application.
 * @param {string} signal - The signal received (e.g., 'SIGINT', 'SIGTERM').
 */
async function gracefulShutdown(signal) {
    logger.info(`Received ${signal}. Shutting down StreamSage gracefully...`);

    // 1. Stop accepting new work (if applicable, e.g., web server)
    // Not directly applicable here, but good practice

    // 2. Stop polling for stream info
    stopStreamInfoPolling(streamInfoIntervalId);

    // 3. Disconnect IRC client
    const ircClient = getIrcClient();
    if (ircClient && ircClient.readyState() === 'OPEN') {
        try {
            logger.info('Disconnecting from Twitch IRC...');
            await ircClient.disconnect();
            logger.info('Disconnected from Twitch IRC.');
        } catch (err) {
            logger.error({ err }, 'Error during IRC disconnect.');
        }
    }

    // 4. Release any other resources (e.g., database connections)
    // Add cleanup here if needed in the future

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

        // --- Initialize Core Components ---
        // Order can matter depending on dependencies
        logger.info('Initializing Gemini Client...');
        initializeGeminiClient(config.gemini); // Assuming sync init for now

        logger.info('Initializing Twitch Helix Client...');
        await initializeHelixClient(config.twitch); // Auth might be async

        logger.info('Initializing Context Manager...');
        initializeContextManager(); // Likely sync init

        logger.info('Initializing Twitch IRC Client...');
        await initializeIrcClient(config.twitch); // Connection is async

        logger.info('Initializing Command Processor...');
        initializeCommandProcessor(); // Likely sync init

        // --- Get Initialized Instances ---
        const ircClient = getIrcClient();
        const contextManager = getContextManager();
        //const commandProcessor = getCommandProcessor(); // Assuming commandProcessor exports this
        const helixClient = getHelixClient(); // Needed for poller
        const geminiClient = getGeminiClient(); // Needed for poller/summarizer

        // --- Setup Event Listeners and Logic ---

        // Handle incoming chat messages
        ircClient.on('message', (channel, tags, message, self) => {
            // Ignore self messages
            if (self) return;

            // Clean channel name (remove #)
            const cleanChannel = channel.substring(1);
            const username = tags['display-name'] || tags.username;

            // Log message received (optional, can be verbose)
            // logger.debug({ channel: cleanChannel, user: username, message }, 'Message received');

            // 1. Update context (async operation)
            contextManager.addMessage(cleanChannel, username, message, tags).catch(err => {
                logger.error({ err, channel: cleanChannel, user: username }, 'Error adding message to context');
            });

            // 2. Process potential commands
            commandProcessor.processMessage(cleanChannel, tags, message).catch(err => {
                 logger.error({ err, channel: cleanChannel, user: username }, 'Error processing command');
            });

            // 3. Determine if LLM response is needed (placeholder for more complex logic)
            // Example: Respond if mentioned or randomly? Needs refinement.
            if (message.toLowerCase().includes(`@${config.twitch.username.toLowerCase()}`)) {
                logger.info({ channel: cleanChannel, user: username }, 'Bot mentioned, considering LLM response...');
                // Trigger LLM response generation (async) - this logic would likely live elsewhere
                // generateLlmResponse(cleanChannel, username, message);
            }
        });

        // Handle IRC connection events
        ircClient.on('connected', (address, port) => {
            logger.info(`Successfully connected to Twitch IRC: ${address}:${port}`);
            // Start polling *after* successful connection
            logger.info(`Starting stream info polling every ${config.app.streamInfoFetchIntervalMs / 1000}s...`);
            streamInfoIntervalId = startStreamInfoPolling(
                config.twitch.channels, // Pass configured channels
                config.app.streamInfoFetchIntervalMs,
                helixClient,
                contextManager
            );
        });

        ircClient.on('disconnected', (reason) => {
            logger.warn(`Disconnected from Twitch IRC: ${reason || 'Unknown reason'}`);
            // Stop polling if disconnected
            stopStreamInfoPolling(streamInfoIntervalId);
            // tmi.js handles reconnection internally based on config, but we might need
            // specific logic here if reconnection fails permanently.
        });

        // Log other events for debugging if needed
        // ircClient.on('join', (channel, username, self) => { ... });
        // ircClient.on('part', (channel, username, self) => { ... });
        // ircClient.on('notice', (channel, msgid, message) => { ... });


        logger.info('StreamSage components initialized and event listeners attached.');
        logger.info(`Ready and listening to channels: ${config.twitch.channels.join(', ')}`);

    } catch (error) {
        logger.fatal({ err: error }, 'Fatal error during StreamSage initialization.');
        process.exit(1); // Exit with error code
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