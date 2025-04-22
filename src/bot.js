import config from './config/index.js';
import logger from './lib/logger.js';
import { createIrcClient, connectIrcClient, getIrcClient } from './components/twitch/ircClient.js';
import { initializeHelixClient, getHelixClient } from './components/twitch/helixClient.js';
// Import getGeminiClient and generateResponse
import { initializeGeminiClient, getGeminiClient, generateResponse as generateLlmResponse, translateText, summarizeText } from './components/llm/geminiClient.js';
import { initializeContextManager, getContextManager, getUserTranslationState, disableUserTranslation } from './components/context/contextManager.js';
import { initializeCommandProcessor, processMessage as processCommand } from './components/commands/commandProcessor.js';
import { startStreamInfoPolling, stopStreamInfoPolling } from './components/twitch/streamInfoPoller.js';

let streamInfoIntervalId = null;
const MAX_IRC_MESSAGE_LENGTH = 450; // Define globally for reuse
const SUMMARY_TARGET_LENGTH = 400;  // Define globally for reuse

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

// --- NEW: Reusable function for standard LLM queries ---
/**
 * Handles getting context, calling the standard LLM, summarizing/truncating, and replying.
 * @param {string} channel - Channel name with '#'.
 * @param {string} cleanChannel - Channel name without '#'.
 * @param {string} displayName - User's display name.
 * @param {string} lowerUsername - User's lowercase username.
 * @param {string} userMessage - The user's message/prompt for the LLM.
 * @param {string} triggerType - For logging ("mention" or "command").
 */
async function handleStandardLlmQuery(channel, cleanChannel, displayName, lowerUsername, userMessage, triggerType = "mention") {
    logger.info({ channel: cleanChannel, user: lowerUsername, trigger: triggerType }, `Handling standard LLM query.`);
    try {
        const contextManager = getContextManager();
        const ircClient = getIrcClient();

        // a. Get context
        const llmContext = contextManager.getContextForLLM(cleanChannel, displayName, userMessage);
        if (!llmContext) {
            logger.warn({ channel: cleanChannel, user: lowerUsername }, 'Could not retrieve context for LLM response.');
            // Maybe send an error message? For now, just return.
            return;
        }

        // b. Generate initial response
        const initialResponseText = await generateLlmResponse(llmContext);
        if (!initialResponseText?.trim()) {
            logger.warn({ channel: cleanChannel, user: lowerUsername, trigger: triggerType }, 'LLM generated null or empty response.');
            await ircClient.say(channel, `@${displayName} Sorry, I couldn't come up with a reply to that.`);
            return;
        }

        // c. Check length and Summarize if needed
        let replyPrefix = `@${displayName} `; // Simple prefix
        let finalReplyText = initialResponseText;

        if ((replyPrefix.length + finalReplyText.length) > MAX_IRC_MESSAGE_LENGTH) {
            logger.info(`Initial LLM response too long (${finalReplyText.length} chars). Attempting summarization.`);
            replyPrefix = `@${displayName} (Summary): `; // Indicate summary

            const summary = await summarizeText(initialResponseText, SUMMARY_TARGET_LENGTH);
            if (summary?.trim()) {
                finalReplyText = summary;
                logger.info(`Summarization successful (${finalReplyText.length} chars).`);
            } else {
                logger.warn(`Summarization failed or returned empty for ${triggerType} response. Falling back to truncation.`);
                const availableLength = MAX_IRC_MESSAGE_LENGTH - replyPrefix.length - 3;
                finalReplyText = initialResponseText.substring(0, availableLength < 0 ? 0 : availableLength) + '...';
            }
        }

        // d. Final length check and Send
        let finalMessage = replyPrefix + finalReplyText;
        if (finalMessage.length > MAX_IRC_MESSAGE_LENGTH) {
             logger.warn(`Final reply (even after summary/truncation) too long (${finalMessage.length} chars). Truncating sharply.`);
             finalMessage = finalMessage.substring(0, MAX_IRC_MESSAGE_LENGTH - 3) + '...';
        }
        await ircClient.say(channel, finalMessage);

    } catch (error) {
        logger.error({ err: error, channel: cleanChannel, user: lowerUsername, trigger: triggerType }, `Error processing standard LLM query.`);
        try {
            const ircClient = getIrcClient();
            await ircClient.say(channel, `@${displayName} Sorry, an error occurred while processing that.`);
        } catch (sayError) { logger.error({ err: sayError }, 'Failed to send LLM error message to chat.'); }
    }
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
            const lowerUsername = tags.username; // Use lowercase for state lookup
            const displayName = tags['display-name'] || tags.username;
            const contextManager = getContextManager();

            // --- Stop Translation Check (runs even if translation is off, for robustness) ---
            const stopPhrases = [
                '!translate stop',
                'stop translating',
                `@${config.twitch.username.toLowerCase()} stop`, // Mention bot + stop
                `@${config.twitch.username.toLowerCase()} stop translating`,
                `@${config.twitch.username.toLowerCase()}, stop translating`,
            ];
            let isStopCommand = false;
            if (stopPhrases.some(phrase => message.toLowerCase().trim() === phrase)) {
                logger.info(`[${cleanChannel}] User ${lowerUsername} used a stop phrase.`);
                const wasStopped = contextManager.disableUserTranslation(cleanChannel, lowerUsername);
                if (wasStopped) {
                    ircClient.say(channel, `@${displayName}, Translation stopped.`).catch(e => 
                        logger.error({ err: e }, 'Failed to send translation stop confirmation'));
                }
                isStopCommand = true; // Prevent further processing of this specific message
            }

            // Exit early if it was a stop command/phrase
            if (isStopCommand) {
                return;
            }

            // 1. Update context (async but don't wait for it)
            contextManager.addMessage(cleanChannel, lowerUsername, message, tags).catch(err => {
                logger.error({ err, channel: cleanChannel, user: lowerUsername }, 'Error adding message to context');
            });

            // 2. Process potential commands (async but don't wait)
            processCommand(cleanChannel, tags, message).catch(err => {
                logger.error({ err, channel: cleanChannel, user: lowerUsername }, 'Error processing command');
            });

            // --- Automatic Translation Logic ---
            const userState = contextManager.getUserTranslationState(cleanChannel, lowerUsername);
            if (userState?.isTranslating && userState.targetLanguage) {
                // Use IIFE for async translation logic
                (async () => {
                    logger.debug(`[${cleanChannel}] Translating message from ${lowerUsername} to ${userState.targetLanguage}`);
                    try {
                        const translatedText = await translateText(message, userState.targetLanguage);
                        if (translatedText) {
                            const reply = `Translation for @${displayName}: ${translatedText}`;
                            // Basic length check for reply
                            if (reply.length > 500) {
                                logger.warn(`Translation reply too long (${reply.length}). Sending truncated.`);
                                await ircClient.say(channel, reply.substring(0, 447) + '...');
                            } else {
                                await ircClient.say(channel, reply);
                            }
                        } else {
                            logger.warn(`[${cleanChannel}] Failed to translate message for ${lowerUsername}`);
                            // Optional: Notify user translation failed? Might be spammy.
                        }
                    } catch (err) {
                        logger.error({ err, channel: cleanChannel, user: lowerUsername }, 'Error during automatic translation.');
                    }
                })();
                // Return here to prevent the mention logic from *also* running on this message
                return;
            }

            // 3. Check for mention and trigger LLM response (only if not translating)
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