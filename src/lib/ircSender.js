import logger from './logger.js';
import { getIrcClient } from '../components/twitch/ircClient.js';
import { translateText } from './translationUtils.js';
import { getContextManager } from '../components/context/contextManager.js';
import { summarizeText } from '../components/llm/geminiClient.js';

// --- Module State ---
const messageQueue = [];
let isSending = false;
let queueIntervalId = null;

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
 * Intelligently truncates text to fit within the specified length,
 * preserving word boundaries and handling UTF-8 characters properly.
 * @param {string} text The text to truncate
 * @param {number} maxLength Maximum length including ellipsis
 * @returns {string} Truncated text with ellipsis if needed
 */
function _intelligentTruncate(text, maxLength) {
    if (!text || typeof text !== 'string') {
        return '';
    }

    if (text.length <= maxLength) {
        return text;
    }

    const ellipsis = '...';
    const availableLength = maxLength - ellipsis.length;

    if (availableLength <= 0) {
        return ellipsis;
    }

    // First, ensure we don't cut in the middle of a UTF-8 character
    let truncated = text.substring(0, availableLength);

    // Check if we cut in the middle of a multi-byte UTF-8 character
    // by trying to encode and seeing if it's valid
    try {
        const encoded = Buffer.from(truncated, 'utf8');
        const decoded = encoded.toString('utf8');
        if (decoded.length < truncated.length) {
            // We cut a multi-byte character, so trim it back
            truncated = decoded;
        }
    } catch (error) {
        // If there's an encoding error, play it safe and trim back further
        logger.debug({ error: error.message }, 'UTF-8 truncation safety check triggered');
        truncated = text.substring(0, Math.max(0, availableLength - 4));
    }

    // Now find the best break point to avoid cutting words

    // 1. Try to break at sentence endings
    const sentenceEndings = ['. ', '! ', '? '];
    let bestBreak = -1;
    let bestBreakScore = 0;

    for (const ending of sentenceEndings) {
        const lastIndex = truncated.lastIndexOf(ending);
        if (lastIndex > availableLength * 0.6) { // Don't go too far back
            const score = lastIndex + (ending.length * 10); // Prefer sentence endings
            if (score > bestBreakScore) {
                bestBreak = lastIndex + ending.length - 1; // Keep the punctuation
                bestBreakScore = score;
            }
        }
    }

    // 2. If no good sentence break, try comma or other punctuation
    if (bestBreak === -1) {
        const punctuationBreaks = [', ', '; ', ': ', ' - ', ' – '];
        for (const punct of punctuationBreaks) {
            const lastIndex = truncated.lastIndexOf(punct);
            if (lastIndex > availableLength * 0.7) {
                const score = lastIndex + punct.length;
                if (score > bestBreakScore) {
                    bestBreak = lastIndex;
                    bestBreakScore = score;
                }
            }
        }
    }

    // 3. Fall back to word boundaries (spaces)
    if (bestBreak === -1) {
        const lastSpace = truncated.lastIndexOf(' ');
        if (lastSpace > availableLength * 0.8) {
            bestBreak = lastSpace;
        }
    }

    // Apply the best break point we found
    if (bestBreak > 0) {
        truncated = text.substring(0, bestBreak).trim();
    }

    return truncated + ellipsis;
}

/**
 * Processes the message queue internally.
 */
async function _processMessageQueue() {
    logger.debug(`_processMessageQueue: isSending=${isSending}, queueLength=${messageQueue.length}`);
    if (isSending || messageQueue.length === 0) {
        logger.debug(`_processMessageQueue: exiting early - isSending=${isSending}, queueLength=${messageQueue.length}`);
        return; // Already running or queue empty
    }

    isSending = true;
    logger.debug(`_processMessageQueue: starting processing, queueLength=${messageQueue.length}`);
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
        logger.debug(`_processMessageQueue: processing message - channel=${channel}, textLength=${text.length}`);
        logger.debug(`Sending queued message to ${channel}: "${text.substring(0, 30)}..." (replyTo: ${replyToId || 'none'})`);
        try {
            if (replyToId && typeof ircClient.raw === 'function') {
                const chan = channel.startsWith('#') ? channel : `#${channel}`;
                const line = `@reply-parent-msg-id=${replyToId} PRIVMSG ${chan} :${text}`;
                await ircClient.raw(line);
            } else {
                await ircClient.say(channel, text);
            }
            logger.debug(`_processMessageQueue: message sent successfully`);
            // Don't wait between messages in tests to avoid timeouts
            await sleep(IRC_SEND_INTERVAL_MS);
        } catch (error) {
            logger.debug(`_processMessageQueue: error sending message - ${error.message}`);
            logger.error({ err: error, channel, text: `"${text.substring(0, 30)}..."`, replyToId: replyToId || null }, 'Failed to send queued message.');
            // Optionally re-queue with retry logic or just log and drop
            await sleep(IRC_SEND_INTERVAL_MS);
        }
    }

    logger.debug(`_processMessageQueue: queue processing completed, setting isSending=false`);
    logger.debug('IRC sender queue processed.');
    isSending = false; // Always reset the flag when queue is empty
}


// --- Public API ---

/**
 * Initializes the IRC Sender and starts the processing interval.
 */
function initializeIrcSender() {
    logger.info('Initializing IRC Sender...');
    if (queueIntervalId) return;

    // Start the queue processor, but allow the process to exit if this is the only handle.
    queueIntervalId = setInterval(_processMessageQueue, IRC_SEND_INTERVAL_MS);
    if (queueIntervalId.unref) {
        queueIntervalId.unref();
    }
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
 * @param {boolean} [options.skipLengthProcessing=false] If true, skips summarization and truncation (already handled).
 */
async function enqueueMessage(channel, text, options = {}) {
    if (!channel || !text || typeof channel !== 'string' || typeof text !== 'string' || text.trim().length === 0) {
        logger.warn({channel, text}, 'Attempted to queue invalid message.');
        return;
    }

    let replyToId = null;
    let skipTranslation = false;
    let skipLengthProcessing = false;

    // Backward compatibility: third param can be boolean skipTranslation
    if (typeof options === 'boolean') {
        skipTranslation = options;
    } else if (options && typeof options === 'object') {
        replyToId = options.replyToId || null;
        skipTranslation = !!options.skipTranslation;
        skipLengthProcessing = !!options.skipLengthProcessing;
    }
    
    let finalText = text;
    
    // Translate if needed (unless explicitly skipped)
    if (!skipTranslation) {
        const channelName = channel.substring(1); // Remove # prefix
        finalText = await _translateIfNeeded(channelName, text);
    }

    // Handle length limits with summarization fallback (only if not already processed)
    if (!skipLengthProcessing && finalText.length > MAX_IRC_MESSAGE_LENGTH) {
        logger.info(`[IRC Sender] Message too long (${finalText.length} chars > ${MAX_IRC_MESSAGE_LENGTH}), attempting LLM summarization.`);

        try {
            const summary = await summarizeText(finalText, SUMMARY_TARGET_LENGTH);
            if (summary?.trim()) {
                const beforeLength = finalText.length;
                finalText = summary.trim();
                // Hard clamp to 450 to guarantee Twitch-safe length even if model slightly exceeds target
                if (finalText.length > SUMMARY_TARGET_LENGTH) {
                    logger.info(`[IRC Sender] Summary still too long (${finalText.length} > ${SUMMARY_TARGET_LENGTH}), applying intelligent truncation.`);
                    finalText = _intelligentTruncate(finalText, SUMMARY_TARGET_LENGTH);
                }
                logger.info(`[IRC Sender] LLM summarization successful: ${beforeLength} chars → ${finalText.length} chars`);
            } else {
                logger.warn(`[IRC Sender] LLM summarization failed. Falling back to intelligent truncation at ${MAX_IRC_MESSAGE_LENGTH} chars.`);
                finalText = _intelligentTruncate(finalText, MAX_IRC_MESSAGE_LENGTH);
                logger.info(`[IRC Sender] Intelligent truncation applied: final length ${finalText.length} chars`);
            }
        } catch (error) {
            logger.error({ err: error }, `[IRC Sender] Error during LLM summarization. Falling back to intelligent truncation.`);
            finalText = _intelligentTruncate(finalText, MAX_IRC_MESSAGE_LENGTH);
            logger.info(`[IRC Sender] Intelligent truncation applied after error: final length ${finalText.length} chars`);
        }

        // Final safety check in case summarization still produced too long text
        if (finalText.length > MAX_IRC_MESSAGE_LENGTH) {
            logger.warn(`[IRC Sender] Message STILL too long after processing (${finalText.length} chars), applying emergency truncation.`);
            finalText = _intelligentTruncate(finalText, MAX_IRC_MESSAGE_LENGTH);
            logger.info(`[IRC Sender] Emergency truncation complete: final length ${finalText.length} chars`);
        }
    } else if (skipLengthProcessing && finalText.length > MAX_IRC_MESSAGE_LENGTH) {
        // Emergency fallback: if length processing was skipped but message is still too long
        logger.warn(`[IRC Sender] Message marked as pre-processed but still too long (${finalText.length} chars). Applying emergency truncation.`);
        finalText = _intelligentTruncate(finalText, MAX_IRC_MESSAGE_LENGTH);
        logger.info(`[IRC Sender] Emergency truncation complete: final length ${finalText.length} chars`);
    } else if (!skipLengthProcessing) {
        logger.debug(`[IRC Sender] Message length OK (${finalText.length} chars ≤ ${MAX_IRC_MESSAGE_LENGTH}), no processing needed.`);
    }

    messageQueue.push({ channel, text: finalText, replyToId });
    logger.info(`[IRC Sender] Message queued for ${channel}: ${finalText.length} chars. Queue size: ${messageQueue.length}`);

    // Trigger processing if not already running
    if (!isSending) {
        _processMessageQueue().catch(err => logger.error({ err }, "Error in _processMessageQueue trigger"));
    }
}

/**
 * Clears the message queue (e.g., on shutdown).
 */
function clearMessageQueue() {
    logger.info(`Clearing IRC message queue (${messageQueue.length} messages) and stopping processor.`);
    if (queueIntervalId) {
        clearInterval(queueIntervalId);
        queueIntervalId = null;
    }
    messageQueue.length = 0;
}

/**
 * Waits for the message queue to be completely processed.
 * Useful for testing to ensure no async operations are pending.
 */
async function waitForQueueEmpty() {
    const maxWaitTime = 5000; // 5 seconds max wait (reduced for tests)
    const checkInterval = 50; // Check every 50ms
    let totalWaitTime = 0;

    logger.debug(`waitForQueueEmpty: isSending=${isSending}, queueLength=${messageQueue.length}`);

    while (isSending && totalWaitTime < maxWaitTime) {
        await sleep(checkInterval);
        totalWaitTime += checkInterval;
        logger.debug(`waitForQueueEmpty: waiting... isSending=${isSending}, queueLength=${messageQueue.length}, totalWait=${totalWaitTime}`);
    }

    if (isSending) {
        logger.warn(`Queue processing did not complete within ${maxWaitTime}ms, forcing completion`);
        isSending = false; // Force reset for tests
    } else {
        logger.debug('Queue processing completed');
    }
}

// Export the public functions
export {
    initializeIrcSender,
    enqueueMessage,
    clearMessageQueue,
    waitForQueueEmpty,
};