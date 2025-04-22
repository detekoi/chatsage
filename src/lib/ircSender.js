import logger from './logger.js';
import { getIrcClient } from '../components/twitch/ircClient.js';

// --- Module State ---
const messageQueue = [];
let isSending = false;

// Minimum delay between sending messages (in milliseconds)
const IRC_SEND_INTERVAL_MS = 1100;
// Max length for IRC messages (conservative)
const MAX_IRC_MESSAGE_LENGTH = 450;


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
        const { channel, text } = messageQueue.shift(); // Get FIFO message
        logger.debug(`Sending queued message to ${channel}: "${text.substring(0, 30)}..."`);
        try {
            await ircClient.say(channel, text);
            await sleep(IRC_SEND_INTERVAL_MS); // Wait AFTER send
        } catch (error) {
            logger.error({ err: error, channel, text: `"${text.substring(0, 30)}..."` }, 'Failed to send queued message.');
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
 * Adds a message to the rate-limited send queue.
 * Truncates message if it exceeds MAX_IRC_MESSAGE_LENGTH.
 * @param {string} channel Channel name with '#'.
 * @param {string} text Message text.
 */
function enqueueMessage(channel, text) {
    if (!channel || !text || typeof channel !== 'string' || typeof text !== 'string' || text.trim().length === 0) {
        logger.warn({channel, text}, 'Attempted to queue invalid message.');
        return;
    }

     // Truncate if necessary before queueing
     if (text.length > MAX_IRC_MESSAGE_LENGTH) {
        logger.warn(`Message too long (${text.length} chars), truncating before queueing.`);
        text = text.substring(0, MAX_IRC_MESSAGE_LENGTH - 3) + '...';
    }

    messageQueue.push({ channel, text });
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