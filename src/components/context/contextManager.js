import logger from '../../lib/logger.js';
import { getHelixClient } from '../twitch/helixClient.js'; // Needed for broadcaster ID lookup
import { triggerSummarizationIfNeeded } from './summarizer.js'; // To trigger summaries

// --- Interfaces (for clarity, not strictly enforced in JS) ---
/*
interface Message {
    timestamp: Date;
    username: string;
    message: string;
    tags: object; // tmi.js message tags
}

interface StreamContext {
    game: string | null;
    title: string | null;
    tags: string[] | null; // Store as array from API
    language: string | null;
    lastUpdated: Date | null;
    fetchErrorCount: number;
}

interface ChannelState {
    channelName: string; // e.g., 'xqc'
    broadcasterId: string | null;
    chatHistory: Message[];
    chatSummary: string;
    streamContext: StreamContext;
}
*/

// --- Constants ---
const MAX_CHAT_HISTORY_LENGTH = 100; // Max messages to keep before summarizing
const CHAT_HISTORY_PRUNE_LENGTH = 10; // Keep N most recent messages after summarizing

// --- State ---
/** @type {Map<string, ChannelState>} */
const channelStates = new Map();

// --- Initialization ---
/**
 * Initializes the Context Manager.
 * Currently just logs, but could pre-load state in the future.
 */
function initializeContextManager() {
    if (channelStates.size > 0) {
        logger.warn('Context Manager already initialized or has existing state.');
    } else {
        logger.info('Initializing Context Manager...');
    }
    // Future: Load state from persistent storage if implemented
}

/**
 * Gets or creates the state object for a given channel.
 * @param {string} channelName - The name of the channel (without '#').
 * @returns {ChannelState} The state object for the channel.
 */
function _getOrCreateChannelState(channelName) {
    if (!channelStates.has(channelName)) {
        logger.info(`Creating new state entry for channel: ${channelName}`);
        channelStates.set(channelName, {
            channelName: channelName,
            broadcasterId: null, // Will be fetched lazily
            chatHistory: [],
            chatSummary: '',
            streamContext: {
                game: null,
                title: null,
                tags: null,
                language: null,
                lastUpdated: null,
                fetchErrorCount: 0,
            },
        });
    }
    return channelStates.get(channelName);
}

/**
 * Adds a chat message to the specified channel's history and triggers summarization if needed.
 * @param {string} channelName - Channel name (without '#').
 * @param {string} username - User who sent the message.
 * @param {string} message - Message content.
 * @param {object} tags - tmi.js message tags.
 */
async function addMessage(channelName, username, message, tags) {
    const state = _getOrCreateChannelState(channelName);
    const newMessage = {
        timestamp: new Date(),
        username,
        message,
        tags,
    };

    state.chatHistory.push(newMessage);

    // Prune very old messages immediately if over max length (simple approach)
    if (state.chatHistory.length > MAX_CHAT_HISTORY_LENGTH) {
        // Trigger summarization asynchronously
        try {
            // Pass the history *before* pruning recent messages
            const summary = await triggerSummarizationIfNeeded(
                channelName,
                state.chatHistory,
                state.chatSummary // Pass current summary for context? Maybe not needed.
            );
            if (summary) {
                state.chatSummary = summary;
                // Prune history after successful summarization
                state.chatHistory = state.chatHistory.slice(-CHAT_HISTORY_PRUNE_LENGTH);
                logger.debug(`Summarized and pruned history for ${channelName}. New length: ${state.chatHistory.length}`);
            } else {
                 // If summarization didn't happen (e.g., not needed yet, or failed),
                 // still prune to prevent unbounded growth, but keep more history maybe?
                 // Simple prune for now:
                 state.chatHistory = state.chatHistory.slice(-MAX_CHAT_HISTORY_LENGTH);
            }
        } catch (error) {
            logger.error({ err: error, channel: channelName }, "Error during summarization trigger/pruning.");
             // Still prune to prevent unbounded growth
             state.chatHistory = state.chatHistory.slice(-MAX_CHAT_HISTORY_LENGTH);
        }
    }
}

/**
 * Updates the stream context information for a channel.
 * @param {string} channelName - Channel name (without '#').
 * @param {object} streamInfo - Object containing game, title, tags, language.
 * @param {string | null} streamInfo.game - Game name.
 * @param {string | null} streamInfo.title - Stream title.
 * @param {string[] | null} streamInfo.tags - Array of tags.
 * @param {string | null} streamInfo.language - Broadcaster language.
 */
function updateStreamContext(channelName, streamInfo) {
    const state = _getOrCreateChannelState(channelName);
    state.streamContext.game = streamInfo.game ?? null;
    state.streamContext.title = streamInfo.title ?? null;
    state.streamContext.tags = streamInfo.tags ?? null;
    state.streamContext.language = streamInfo.language ?? null;
    state.streamContext.lastUpdated = new Date();
    state.streamContext.fetchErrorCount = 0; // Reset errors on successful update
    logger.debug({ channel: channelName, context: state.streamContext }, 'Updated stream context.');
}

/**
 * Records a failure to fetch stream context for a channel.
 * @param {string} channelName - Channel name (without '#').
 */
function recordStreamContextFetchError(channelName) {
    const state = _getOrCreateChannelState(channelName);
    state.streamContext.fetchErrorCount += 1;
    logger.warn({ channel: channelName, errorCount: state.streamContext.fetchErrorCount }, 'Recorded stream context fetch error.');
    // Add logic here if needed: e.g., stop polling after X errors
}

/**
 * Formats recent chat history into a simple string.
 * @param {Message[]} history - Array of message objects.
 * @returns {string} Formatted string (e.g., "User1: msg1\nUser2: msg2").
 */
function _formatRecentHistory(history) {
    return history.map(msg => `${msg.username}: ${msg.message}`).join('\n');
}


/**
 * Retrieves the combined context needed for an LLM prompt.
 * @param {string} channelName - Channel name (without '#').
 * @param {string} currentUsername - The user whose message triggered the request.
 * @param {string} currentMessage - The message content that triggered the request.
 * @returns {object | null} Context object for buildPrompt, or null if state doesn't exist.
 */
function getContextForLLM(channelName, currentUsername, currentMessage) {
    if (!channelStates.has(channelName)) {
        logger.warn(`No state found for channel ${channelName} when requesting LLM context.`);
        return null;
    }
    const state = channelStates.get(channelName);
    const recentHistory = state.chatHistory.slice(-15); // Get last ~15 messages for immediate context

    return {
        streamGame: state.streamContext.game,
        streamTitle: state.streamContext.title,
        streamTags: state.streamContext.tags?.join(', ') || null, // Join tags array
        chatSummary: state.chatSummary || "No conversation summary available yet.", // Provide default
        recentChatHistory: _formatRecentHistory(recentHistory),
        username: currentUsername, // Pass these through
        currentMessage: currentMessage, // Pass these through
    };
}

/**
 * Lazily fetches and caches the broadcaster ID for a channel name.
 * Requires helixClient.getUsersByLogin to be implemented.
 * @param {string} channelName - Channel name (without '#').
 * @returns {Promise<string | null>} Broadcaster user ID, or null if lookup fails.
 */
async function getBroadcasterId(channelName) {
    const state = _getOrCreateChannelState(channelName);
    if (state.broadcasterId) {
        return state.broadcasterId;
    }

    logger.info(`Broadcaster ID not cached for ${channelName}. Fetching from Helix...`);
    try {
        const helixClient = getHelixClient(); // Assumes helixClient is initialized
        // We need a function like this in helixClient.js:
        const users = await helixClient.getUsersByLogin([channelName]);

        if (users && users.length > 0) {
            state.broadcasterId = users[0].id;
            logger.info(`Cached broadcaster ID for ${channelName}: ${state.broadcasterId}`);
            return state.broadcasterId;
        } else {
            logger.error(`Could not find broadcaster ID for channel name: ${channelName}`);
            return null;
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `Failed to fetch broadcaster ID for ${channelName}`);
        return null;
    }
}

/**
 * Gets a list of channels and their broadcaster IDs currently managed.
 * Will attempt to fetch missing IDs.
 * @returns {Promise<Array<{channelName: string, broadcasterId: string}>>} List of channels ready for polling.
 */
async function getChannelsForPolling() {
    const channelsToPoll = [];
    // Create a list of promises for fetching missing IDs
    const idFetchPromises = [];

    for (const channelName of channelStates.keys()) {
         const state = channelStates.get(channelName);
         if (state.broadcasterId) {
            channelsToPoll.push({ channelName: state.channelName, broadcasterId: state.broadcasterId });
         } else {
            // Add promise to fetch missing ID
            idFetchPromises.push(
                getBroadcasterId(channelName).then(id => {
                    if (id) {
                        channelsToPoll.push({ channelName: channelName, broadcasterId: id });
                    }
                    // If ID fetch fails, it's logged in getBroadcasterId, we just don't add it here
                })
            );
         }
    }

    // Wait for all missing ID fetches to complete
    await Promise.all(idFetchPromises);

    return channelsToPoll;
}


// Define what the "manager" object exposes
const manager = {
    initialize: initializeContextManager,
    addMessage: addMessage,
    updateStreamContext: updateStreamContext,
    recordStreamContextFetchError: recordStreamContextFetchError,
    getContextForLLM: getContextForLLM,
    getBroadcasterId: getBroadcasterId, // Expose if needed directly elsewhere
    getChannelsForPolling: getChannelsForPolling,
};

/**
 * Gets the singleton Context Manager instance/interface.
 */
function getContextManager() {
    // In this simple case, we just return the manager object.
    // If more complex state/methods were private, this could return a more restricted interface.
    return manager;
}

export { initializeContextManager, getContextManager };