import config from './config/index.js';
import logger from './lib/logger.js';
import { createIrcClient, connectIrcClient, getIrcClient } from './components/twitch/ircClient.js';
import { initializeHelixClient, getHelixClient } from './components/twitch/helixClient.js';
import { initializeGeminiClient, getGeminiClient, generateStandardResponse as generateLlmResponse, translateText, summarizeText } from './components/llm/geminiClient.js';
import { initializeContextManager, getContextManager, getUserTranslationState, disableUserTranslation } from './components/context/contextManager.js';
import { initializeCommandProcessor, processMessage as processCommand } from './components/commands/commandProcessor.js';
import { startStreamInfoPolling, stopStreamInfoPolling } from './components/twitch/streamInfoPoller.js';
import { initializeIrcSender, enqueueMessage, clearMessageQueue } from './lib/ircSender.js';
import { handleStandardLlmQuery } from './components/llm/llmUtils.js';

let streamInfoIntervalId = null;
const MAX_IRC_MESSAGE_LENGTH = 450; // Define globally for reuse
const SUMMARY_TARGET_LENGTH = 400;  // Define globally for reuse

/**
 * Gracefully shuts down the application.
 */
async function gracefulShutdown(signal) {
    logger.info(`Received ${signal}. Shutting down StreamSage gracefully...`);
    stopStreamInfoPolling(streamInfoIntervalId);
    clearMessageQueue(); // Clear the message queue before disconnecting
    
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

        logger.info('Initializing IRC Sender...');
        initializeIrcSender();

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

            // --- Stop Translation Check ---
            const stopPhrases = [
                '!translate stop',
                'stop translating',
                'stop translate',
                `@${config.twitch.username.toLowerCase()} stop`, // Mention bot + stop
                `@${config.twitch.username.toLowerCase()} stop translating`,
                `@${config.twitch.username.toLowerCase()} stop translate`,
                `@${config.twitch.username.toLowerCase()}, stop translating`,
            ];
            let isStopCommand = false;
            if (stopPhrases.some(phrase => message.toLowerCase().trim() === phrase)) {
                logger.info(`[${cleanChannel}] Received stop phrase from ${lowerUsername} (self=${self}).`);
                const wasStopped = contextManager.disableUserTranslation(cleanChannel, lowerUsername);
                if (wasStopped) {
                    enqueueMessage(channel, `@${displayName}, Translation stopped.`);
                }
                isStopCommand = true;
            }

            if (isStopCommand) {
                contextManager.addMessage(cleanChannel, lowerUsername, message, tags).catch(err => {
                    logger.error({ err, channel: cleanChannel, user: lowerUsername }, 'Error adding message to context');
                });
                return;
            }

            // 1. Add user message to context (async)
            contextManager.addMessage(cleanChannel, lowerUsername, message, tags).catch(err => {
                logger.error({ err, channel: cleanChannel, user: lowerUsername }, 'Error adding message to context');
            });

            // 2. Process potential commands (async) AND check if one ran
            let commandProcessed = false; // Flag
            processCommand(cleanChannel, tags, message)
                .then(processed => {
                    commandProcessed = processed; // Set flag based on return value
                    // Now check translation/mention ONLY if a command DID NOT run
                    if (!commandProcessed) {
                        // --- Automatic Translation Logic ---
                        const userState = contextManager.getUserTranslationState(cleanChannel, lowerUsername);
                        if (userState?.isTranslating && userState.targetLanguage) {
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
                            return; // Don't process mention if translating
                        }

                        // --- Mention Check ---
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
                })
                .catch(err => {
                    logger.error({ err, channel: cleanChannel, user: lowerUsername }, 'Error processing command');
                });
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