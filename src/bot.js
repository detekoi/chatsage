import config from './config/index.js';
import logger from './lib/logger.js';
import { createIrcClient, connectIrcClient, getIrcClient } from './components/twitch/ircClient.js';
import { initializeHelixClient, getHelixClient } from './components/twitch/helixClient.js';
// Import getGeminiClient and generateResponse
import { initializeGeminiClient, getGeminiClient, generateResponse as generateLlmResponse } from './components/llm/geminiClient.js';
import { initializeContextManager, getContextManager } from './components/context/contextManager.js';
import { initializeCommandProcessor, processMessage as processCommand } from './components/commands/commandProcessor.js';
import { startStreamInfoPolling, stopStreamInfoPolling } from './components/twitch/streamInfoPoller.js';

let streamInfoIntervalId = null;

/**
 * Gracefully shuts down the application.
 */
async function gracefulShutdown(signal) {
    logger.info(`Received ${signal}. Shutting down StreamSage gracefully...`);
    stopStreamInfoPolling(streamInfoIntervalId);
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
        logger.info('Initializing Gemini Client...');
        initializeGeminiClient(config.gemini);

        logger.info('Initializing Twitch Helix Client...');
        await initializeHelixClient(config.twitch);

        logger.info('Initializing Context Manager...');
        initializeContextManager(config.twitch.channels);

        logger.info('Initializing Command Processor...');
        initializeCommandProcessor();

        // --- Get Instances needed before IRC connection ---
        const contextManager = getContextManager();
        const helixClient = getHelixClient();
        // Get gemini client instance early if needed, or get inside async IIFE
        // const geminiClient = getGeminiClient();

        // --- Create IRC Client Instance ---
        logger.info('Creating Twitch IRC Client instance...');
        const ircClient = createIrcClient(config.twitch);

        // --- Setup IRC Event Listeners BEFORE Connecting ---
        logger.debug('Attaching IRC event listeners...');

        ircClient.on('connected', (address, port) => {
            logger.info(`Successfully connected to Twitch IRC: ${address}:${port}`);
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
        });

        // --- MESSAGE HANDLER ---
        ircClient.on('message', (channel, tags, message, self) => {
            // Ignore self messages
            if (self) return;

            const cleanChannel = channel.substring(1);
            const username = tags['display-name'] || tags.username;

            // 1. Update context (async but don't wait for it)
            contextManager.addMessage(cleanChannel, username, message, tags).catch(err => {
                logger.error({ err, channel: cleanChannel, user: username }, 'Error adding message to context');
            });

            // 2. Process potential commands (async but don't wait)
            processCommand(cleanChannel, tags, message).catch(err => {
                 logger.error({ err, channel: cleanChannel, user: username }, 'Error processing command');
            });

            // 3. Check for mention and trigger LLM response (async IIFE)
            if (message.toLowerCase().includes(`@${config.twitch.username.toLowerCase()}`)) {
                logger.info({ channel: cleanChannel, user: username }, 'Bot mentioned, considering LLM response...');

                // Use an async IIFE to handle the async operations without blocking message processing
                (async () => {
                    try {
                        // Get fresh instances inside async scope if preferred, or use ones from outer scope
                        const currentContextManager = getContextManager();
                        // const currentGeminiClient = getGeminiClient(); // No need, using imported function
                        const currentIrcClient = getIrcClient();

                        // a. Get context for the LLM
                        const llmContext = currentContextManager.getContextForLLM(cleanChannel, username, message);

                        if (!llmContext) {
                            logger.warn({ channel: cleanChannel, user: username }, 'Could not retrieve context for LLM response.');
                            return; // Exit if no context available
                        }

                        // b. Call the imported generateLlmResponse function
                        const responseText = await generateLlmResponse(llmContext);

                        // c. Check and send the response
                        if (responseText && responseText.trim().length > 0) {
                             logger.info({ channel: cleanChannel, responseLength: responseText.length }, 'Sending LLM response to chat.');
                             // Add username prefix for clarity in chat
                             const formattedResponse = `@${username} ${responseText}`;
                             await currentIrcClient.say(channel, formattedResponse); // Use original channel with #
                        } else {
                            logger.warn({ channel: cleanChannel }, 'LLM generated null or empty response for mention.');
                            // Optionally send a default message like "Sorry, I couldn't generate a response."
                            // await currentIrcClient.say(channel, `@${username} Sorry, I had trouble thinking of a reply.`);
                        }

                    } catch (error) {
                         logger.error({ err: error, channel: cleanChannel, user: username }, 'Error processing LLM response for mention.');
                         // Optional: Notify user of error?
                         try {
                              const currentIrcClient = getIrcClient();
                              await currentIrcClient.say(channel, `@${username} Sorry, an error occurred while processing your request.`);
                         } catch (sayError) {
                             logger.error({ err: sayError }, 'Failed to send LLM error message to chat.');
                         }
                    }
                })(); // Immediately invoke the async function
            }
        }); // End of message handler

        // Add other basic listeners
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
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// --- Start the Application ---
main();

// --- Optional: Unhandled Rejection/Exception Handling ---
process.on('unhandledRejection', (reason, promise) => {
    logger.error({ reason, promise }, 'Unhandled Rejection at Promise');
});
process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught Exception thrown');
    process.exit(1);
});