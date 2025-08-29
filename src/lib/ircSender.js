import logger from './logger.js';
import { getIrcClient } from '../components/twitch/ircClient.js';
import { translateText } from './translationUtils.js';
import { getContextManager } from '../components/context/contextManager.js';
import { summarizeText } from '../components/llm/geminiClient.js';

// --- Module State ---
const messageQueue = [];
let isSending = false;

// Minimum delay between sending messages (in milliseconds)
const IRC_SEND_INTERVAL_MS = 1100;
// Twitch IRC message limit is 500 characters
const MAX_IRC_MESSAGE_LENGTH = 500;
// Target length for summaries (should be less than MAX_IRC_MESSAGE_LENGTH)
const SUMMARY_TARGET_LENGTH = 400;


// --- Internal Helper ---
/**
 * Utility function for async sleep
 * @param {number} ms Milliseconds to sleep
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Processes the message queue internally.
 */
async function _processMessageQueue() {
    if (isSending || messageQueue.length === 0) {
        return; // Already running or queue empty
    }

    isSending = true;
    logger.debug(`Starting IRC sender queue processing (length: ${messageQueue.length})`);

    let ircClient = null;
    try {
        ircClient = getIrcClient(); // Get client instance
    } catch (err) {
        logger.error({ err }, "Failed to get IRC client in _processMessageQueue. Aborting queue processing.");
        isSending = false;
        messageQueue.length = 0; // Clear queue as we can't send
        return;
    }

    while (messageQueue.length > 0) {
        const { channel, text, replyToId } = messageQueue.shift(); // Get FIFO message
        logger.debug(`Sending queued message to ${channel}: "${text.substring(0, 30)}..." (replyTo: ${replyToId || 'none'})`);
        try {
            if (replyToId && typeof ircClient.raw === 'function') {
                const chan = channel.startsWith('#') ? channel : `#${channel}`;
                const line = `@reply-parent-msg-id=${replyToId} PRIVMSG ${chan} :${text}`;
                await ircClient.raw(line);
            } else {
                await ircClient.say(channel, text);
            }
            await sleep(IRC_SEND_INTERVAL_MS); // Wait AFTER send
        } catch (error) {
            logger.error({ err: error, channel, text: `"${text.substring(0, 30)}..."`, replyToId: replyToId || null }, 'Failed to send queued message.');
            // Optionally re-queue with retry logic or just log and drop
            await sleep(IRC_SEND_INTERVAL_MS); // Still wait even on error
        }
    }

    logger.debug('IRC sender queue processed.');
    isSending = false;
}


// --- Public API ---

/**
 * Initializes the IRC Sender (placeholder for future setup).
 */
function initializeIrcSender() {
    logger.info('Initializing IRC Sender...');
    // Future: Could load rate limit settings, etc.
}

/**
 * Translates a message if needed based on channel's bot language setting
 * @param {string} channelName Channel name without '#'
 * @param {string} text Original message text
 * @returns {Promise<string>} Translated text if needed, or original text
 */
async function _translateIfNeeded(channelName, text) {
    const contextManager = getContextManager();
    const botLanguage = contextManager.getBotLanguage(channelName);
    
    if (!botLanguage) {
        // No translation needed
        return text;
    }
    
    try {
        logger.debug(`Translating bot message to ${botLanguage} for channel ${channelName}`);
        const translatedText = await translateText(text, botLanguage);
        
        if (!translatedText || translatedText.trim().length === 0) {
            logger.warn(`Translation to ${botLanguage} failed, using original text`);
            return text;
        }
        
        logger.debug(`Successfully translated message to ${botLanguage}`);
        return translatedText;
    } catch (error) {
        logger.error({ err: error }, `Error translating message to ${botLanguage}`);
        return text; // Fall back to original text on error
    }
}

/**
 * Adds a message to the rate-limited send queue.
 * Translates the message if the channel has a language setting.
 * Summarizes message if it exceeds MAX_IRC_MESSAGE_LENGTH.
 * @param {string} channel Channel name with '#'.
 * @param {string} text Message text.
 * @param {object|boolean} [options={}] Optional params or legacy boolean for skipTranslation.
 * @param {string|null} [options.replyToId=null] The ID of the message to reply to.
 * @param {boolean} [options.skipTranslation=false] If true, skips translation.
 */
async function enqueueMessage(channel, text, options = {}) {
    if (!channel || !text || typeof channel !== 'string' || typeof text !== 'string' || text.trim().length === 0) {
        logger.warn({channel, text}, 'Attempted to queue invalid message.');
        return;
    }

    let replyToId = null;
    let skipTranslation = false;

    // Backward compatibility: third param can be boolean skipTranslation
    if (typeof options === 'boolean') {
        skipTranslation = options;
    } else if (options && typeof options === 'object') {
        replyToId = options.replyToId || null;
        skipTranslation = !!options.skipTranslation;
    }
    
    let finalText = text;
    
    // Translate if needed (unless explicitly skipped)
    if (!skipTranslation) {
        const channelName = channel.substring(1); // Remove # prefix
        finalText = await _translateIfNeeded(channelName, text);
    }

    // Handle length limits with summarization fallback
    if (finalText.length > MAX_IRC_MESSAGE_LENGTH) {
        logger.info(`Message too long (${finalText.length} chars), attempting summarization before queueing.`);
        
        try {
            const summary = await summarizeText(finalText, SUMMARY_TARGET_LENGTH);
            if (summary?.trim()) {
                finalText = summary;
                logger.info(`Message summarization successful (${finalText.length} chars).`);
            } else {
                logger.warn(`Summarization failed. Falling back to truncation.`);
                finalText = finalText.substring(0, MAX_IRC_MESSAGE_LENGTH - 3) + '...';
            }
        } catch (error) {
            logger.error({ err: error }, 'Error during message summarization. Falling back to truncation.');
            finalText = finalText.substring(0, MAX_IRC_MESSAGE_LENGTH - 3) + '...';
        }
        
        // Final safety check in case summarization still produced too long text
        if (finalText.length > MAX_IRC_MESSAGE_LENGTH) {
            logger.warn(`Summarized message still too long (${finalText.length} chars), truncating.`);
            finalText = finalText.substring(0, MAX_IRC_MESSAGE_LENGTH - 3) + '...';
        }
    }

    messageQueue.push({ channel, text: finalText, replyToId });
    logger.debug(`Message queued for ${channel}. Queue size: ${messageQueue.length}`);

    // Trigger processing if not already running
    if (!isSending) {
        _processMessageQueue().catch(err => logger.error({ err }, "Error in _processMessageQueue trigger"));
    }
}

/**
 * Clears the message queue (e.g., on shutdown).
 */
function clearMessageQueue() {
    logger.info(`Clearing IRC message queue (${messageQueue.length} messages).`);
    messageQueue.length = 0;
}

// Export the public functions
export {
    initializeIrcSender,
    enqueueMessage,
    clearMessageQueue,
};