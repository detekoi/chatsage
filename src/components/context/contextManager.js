import logger from '../../lib/logger.js';
import { getUsersByLogin } from '../twitch/helixClient.js'; // Import both functions
import { triggerSummarizationIfNeeded } from './summarizer.js'; // To trigger summaries
import { saveChannelLanguage, loadAllChannelLanguages } from './languageStorage.js';
import { saveUserTranslation, removeUserTranslation, loadAllUserTranslations } from './translationStorage.js';
import { getEmoteContextString } from '../../lib/geminiEmoteDescriber.js';

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
    gameId: string | null;
    title: string | null;
    tags: string[] | null; // Store as array from API
    language: string | null;
    lastUpdated: Date | null;
    fetchErrorCount: number;
    viewerCount: number | null;
    startedAt: string | null;
    offlineMissCount: number; // consecutive polls reporting offline
}

interface UserState { // <-- NEW Interface
    username: string; // Store the username lowercase for consistent lookup
    isTranslating: boolean;
    targetLanguage: string | null;
}

interface ChannelState {
    channelName: string; // e.g., 'xqc'
    broadcasterId: string | null;
    chatHistory: Message[];
    chatSummary: string;
    isSummarizing: boolean; // <-- Lock flag to prevent concurrent summarization
    streamContext: StreamContext;
    userStates: Map<string, UserState>; // <-- Map: username -> UserState
    botLanguage: string | null; // <-- Channel-specific bot language setting
}
*/

// --- Constants ---
const MAX_CHAT_HISTORY_LENGTH = 30; // Max messages to keep before summarizing
const CHAT_HISTORY_PRUNE_LENGTH = 10; // Keep N most recent messages after summarizing

// --- State ---
/** @type {Map<string, ChannelState>} */
const channelStates = new Map();

// --- Helpers ---
function _normalizeStringOrNull(value) {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
}

// --- Initialization ---
/**
 * Initializes the Context Manager by creating initial state entries
 * for all configured channels.
 * @param {string[]} configuredChannels - Array of channel names (without '#').
 */
async function initializeContextManager(configuredChannels = []) {
    if (channelStates.size > 0) {
        logger.warn('Context Manager already initialized or has existing state.');
        // Optionally clear or handle existing state if re-initializing
    } else {
        logger.info('Initializing Context Manager...');
        if (configuredChannels.length === 0) {
            logger.warn('No configured channels provided to Context Manager on initialization.');
        }
        // Pre-populate state for each configured channel
        for (const channelName of configuredChannels) {
            _getOrCreateChannelState(channelName); // This populates the map
        }
        logger.info(`Context Manager initialized for channels: ${configuredChannels.join(', ')}`);
    }
    // Load language settings from Firestore
    try {
        const languageSettings = await loadAllChannelLanguages();
        // Apply stored settings to memory state
        languageSettings.forEach((language, channelName) => {
            if (channelStates.has(channelName)) {
                channelStates.get(channelName).botLanguage = language;
                logger.debug(`Applied stored language setting for ${channelName}: ${language || 'default'}`);
            }
        });
    } catch (error) {
        logger.error({ err: error }, 'Failed to load stored language settings');
    }

    // Load user translation states from Firestore
    try {
        const translations = await loadAllUserTranslations();
        for (const { channelName, username, targetLanguage } of translations) {
            // Only restore if the channel is configured
            if (channelStates.has(channelName)) {
                const userState = _getOrCreateUserState(channelName, username);
                userState.isTranslating = true;
                userState.targetLanguage = targetLanguage;
                logger.debug(`Restored translation for ${username} in ${channelName}: ${targetLanguage}`);
            }
        }
        if (translations.length > 0) {
            logger.info(`Restored ${translations.length} user translation(s) from Firestore`);
        }
    } catch (error) {
        logger.error({ err: error }, 'Failed to load stored user translations');
    }
}

/**
 * Gets or creates the state object for a given channel.
 * @param {string} channelName - The name of the channel (without '#').
 * @returns {ChannelState} The state object for the channel.
 */
function _getOrCreateChannelState(channelName) {
    if (!channelStates.has(channelName)) {
        // Log level changed to DEBUG as this is now expected during init
        logger.debug(`Creating new state entry for channel: ${channelName}`);
        channelStates.set(channelName, {
            channelName: channelName,
            broadcasterId: null,
            chatHistory: [],
            chatSummary: '',
            isSummarizing: false,
            streamContext: {
                game: null,
                gameId: null,
                title: null,
                tags: null,
                language: null,
                lastUpdated: null,
                fetchErrorCount: 0,
                viewerCount: 0,
                startedAt: null,
                offlineMissCount: 0,
            },
            userStates: new Map(), // <-- Initialize the userStates Map here
            botLanguage: null // <-- Initialize with no language preference
        });
    }
    return channelStates.get(channelName);
}

/**
 * Gets or creates the state object for a given user within a channel.
 * @param {string} channelName - Channel name (without '#').
 * @param {string} username - Username (lowercase).
 * @returns {UserState} The state object for the user in that channel.
 */
function _getOrCreateUserState(channelName, username) {
    const channelState = _getOrCreateChannelState(channelName);
    const lowerUser = username.toLowerCase(); // Use lowercase for map key consistency
    if (!channelState.userStates.has(lowerUser)) {
        logger.debug(`[${channelName}] Creating new state for user: ${lowerUser}`);
        channelState.userStates.set(lowerUser, {
            username: lowerUser,
            isTranslating: false,
            targetLanguage: null,
        });
    }
    return channelState.userStates.get(lowerUser);
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

    // Compute emote context as a separate field (does not modify the original message)
    let emoteContext = null;
    try {
        emoteContext = await getEmoteContextString(tags, message);
    } catch (err) {
        logger.debug({ err: err.message, channel: channelName }, 'Emote context generation failed');
    }

    const newMessage = {
        timestamp: new Date(),
        username,
        message,
        emoteContext,
        tags,
    };

    state.chatHistory.push(newMessage);

    // Check if history is too long AND if a summary isn't already running
    if (state.chatHistory.length > MAX_CHAT_HISTORY_LENGTH && !state.isSummarizing) {
        state.isSummarizing = true; // Set lock
        try {
            // Pass the history *before* pruning recent messages
            const summary = await triggerSummarizationIfNeeded(
                channelName,
                state.chatHistory,
                state.chatSummary
            );
            if (summary) {
                state.chatSummary = summary;
                // Prune history after successful summarization
                state.chatHistory = state.chatHistory.slice(-CHAT_HISTORY_PRUNE_LENGTH);
                logger.debug(`Summarized and pruned history for ${channelName}. New length: ${state.chatHistory.length}`);
            } else {
                // If summarization failed, prune more aggressively to prevent unbounded growth
                logger.warn(`[${channelName}] Summarization failed, pruning chat history more aggressively to prevent token overflow.`);
                state.chatHistory = state.chatHistory.slice(-CHAT_HISTORY_PRUNE_LENGTH);
                logger.debug(`Pruned history for ${channelName} after summarization failure. New length: ${state.chatHistory.length}`);
            }
        } catch (error) {
            logger.error({ err: error, channel: channelName }, "Error during summarization trigger/pruning.");
            // Prune aggressively to prevent unbounded growth when summarization throws errors
            logger.warn(`[${channelName}] Exception during summarization, pruning chat history aggressively to prevent token overflow.`);
            state.chatHistory = state.chatHistory.slice(-CHAT_HISTORY_PRUNE_LENGTH);
        } finally {
            state.isSummarizing = false; // Release lock
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
    state.streamContext.game = _normalizeStringOrNull(streamInfo.game) ?? null;
    state.streamContext.gameId = _normalizeStringOrNull(streamInfo.gameId) ?? state.streamContext.gameId ?? null;
    state.streamContext.title = _normalizeStringOrNull(streamInfo.title) ?? null;
    state.streamContext.tags = streamInfo.tags ?? null;
    state.streamContext.language = _normalizeStringOrNull(streamInfo.language) ?? null;
    state.streamContext.viewerCount = typeof streamInfo.viewerCount === 'number' ? streamInfo.viewerCount : state.streamContext.viewerCount ?? 0;
    state.streamContext.startedAt = _normalizeStringOrNull(streamInfo.startedAt) ?? state.streamContext.startedAt ?? null;
    state.streamContext.lastUpdated = new Date();
    state.streamContext.fetchErrorCount = 0; // Reset errors on successful update
    state.streamContext.offlineMissCount = 0; // Reset offline miss counter on successful live update
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
 * Records an offline miss (a poll cycle that didn't see the stream live).
 * Clears the context only after a small threshold of consecutive misses to avoid flapping.
 * @param {string} channelName - Channel name (without '#').
 * @param {number} threshold - Number of consecutive misses before clearing.
 */
function recordOfflineMiss(channelName, threshold = 2) {
    const state = _getOrCreateChannelState(channelName);
    state.streamContext.offlineMissCount = (state.streamContext.offlineMissCount || 0) + 1;
    logger.debug({ channel: channelName, misses: state.streamContext.offlineMissCount, threshold }, 'Recorded offline miss.');
    if (state.streamContext.offlineMissCount >= threshold) {
        // Only clear if not already cleared (avoid repeated clearing for offline streams)
        if (state.streamContext.game !== 'N/A') {
            clearStreamContext(channelName);
        }
    }
}

/**
 * Clears the stream-specific context for a channel, typically after going offline.
 * @param {string} channelName - Channel name (without '#').
 */
function clearStreamContext(channelName) {
    const state = _getOrCreateChannelState(channelName);
    state.streamContext.game = 'N/A';
    state.streamContext.gameId = null;
    state.streamContext.title = 'N/A';
    state.streamContext.tags = [];
    state.streamContext.viewerCount = 0;
    state.streamContext.startedAt = null;
    state.streamContext.lastUpdated = new Date();
    state.streamContext.fetchErrorCount = 0; // Reset error count
    state.streamContext.offlineMissCount = 0; // Reset after clearing
    logger.info(`[${channelName}] Stream context has been cleared.`);
}

/**
 * Clears the thematic context (chatSummary) when a significant context shift
 * occurs, like a game change. This prevents old themes from contaminating
 * new game prompts while preserving recent chat history.
 * @param {string} channelName - Channel name (without '#').
 */
function clearThematicContext(channelName) {
    const state = _getOrCreateChannelState(channelName);
    if (state.chatSummary) {
        logger.info(`[${channelName}] Clearing thematic context (old summary: "${state.chatSummary.substring(0, 50)}...").`);
        state.chatSummary = '';
    }
    // Keep chatHistory intact - it will naturally cycle out old messages
    // and provides useful recent context even across game changes
}

/**
 * Formats recent chat history into a simple string.
 * @param {Message[]} history - Array of message objects.
 * @returns {string} Formatted string (e.g., "User1: msg1\nUser2: msg2").
 */
function _formatRecentHistory(history) {
    return history.map(msg => {
        const base = `${msg.username}: ${msg.message}`;
        return msg.emoteContext ? `${base} ${msg.emoteContext}` : base;
    }).join('\n');
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
        channelName: state.channelName,
        streamGame: state.streamContext.game,
        streamGameId: state.streamContext.gameId,
        streamTitle: state.streamContext.title,
        streamTags: state.streamContext.tags?.join(', ') || null, // Join tags array
        viewerCount: state.streamContext.viewerCount ?? 0,
        streamStartedAt: state.streamContext.startedAt ?? null,
        chatSummary: state.chatSummary || "No conversation summary available yet.", // Provide default
        recentChatHistory: _formatRecentHistory(recentHistory),
        username: currentUsername, // Pass these through
        currentMessage: currentMessage, // Pass these through
    };
}

/**
 * Gets merged context from multiple channels in a shared chat session.
 * Combines chat history and stream contexts from all participating channels.
 * @param {string[]} channelNames - Array of channel names participating in the shared session.
 * @param {string} currentUsername - The user currently messaging.
 * @param {string} currentMessage - The current message from the user.
 * @returns {object|null} Merged context for LLM, or null if unable to build.
 */
function getMergedContextForLLM(channelNames, currentUsername, currentMessage) {
    if (!Array.isArray(channelNames) || channelNames.length === 0) {
        logger.warn('getMergedContextForLLM called with invalid channelNames');
        return null;
    }

    // Collect all channel states
    const channelContexts = [];
    const allMessages = [];
    const channelSummaries = [];
    const streamInfos = [];

    for (const channelName of channelNames) {
        if (!channelStates.has(channelName)) {
            logger.debug(`No state found for channel ${channelName} in merged context`);
            continue;
        }

        const state = channelStates.get(channelName);
        channelContexts.push(state);

        // Collect chat history with channel origin
        const messagesWithOrigin = state.chatHistory.map(msg => ({
            ...msg,
            originChannel: channelName
        }));
        allMessages.push(...messagesWithOrigin);

        // Collect summaries
        if (state.chatSummary && state.chatSummary !== "No conversation summary available yet.") {
            channelSummaries.push(`[${channelName}] ${state.chatSummary}`);
        }

        // Collect stream info
        if (state.streamContext.game && state.streamContext.game !== 'N/A') {
            streamInfos.push({
                channel: channelName,
                game: state.streamContext.game,
                title: state.streamContext.title,
                viewerCount: state.streamContext.viewerCount ?? 0,
                startedAt: state.streamContext.startedAt
            });
        }
    }

    if (allMessages.length === 0) {
        logger.warn('No messages found across any channels in shared session');
        return null;
    }

    // Sort all messages by timestamp to create a unified timeline
    allMessages.sort((a, b) => {
        const timeA = a.timestamp instanceof Date ? a.timestamp : new Date(a.timestamp);
        const timeB = b.timestamp instanceof Date ? b.timestamp : new Date(b.timestamp);
        return timeA - timeB;
    });

    // Take recent messages from the merged timeline
    const recentMergedHistory = allMessages.slice(-15);

    // Format stream info
    const streamContextText = streamInfos.length > 0
        ? streamInfos.map(info => `${info.channel}: "${info.title}" playing ${info.game} (${info.viewerCount} viewers)`).join('\n')
        : 'No active streams';

    // Format merged summary
    const mergedSummary = channelSummaries.length > 0
        ? channelSummaries.join('\n\n')
        : "No conversation summaries available yet.";

    return {
        channelName: `[Shared: ${channelNames.join(', ')}]`,
        isSharedSession: true,
        participatingChannels: channelNames,
        streamGame: streamInfos.map(s => s.game).join(' & ') || 'N/A',
        streamGameId: null, // Not applicable for merged sessions
        streamTitle: `Shared stream: ${channelNames.join(' & ')}`,
        streamTags: null,
        viewerCount: streamInfos.reduce((sum, s) => sum + s.viewerCount, 0),
        streamStartedAt: null,
        streamContextDetails: streamContextText,
        chatSummary: mergedSummary,
        recentChatHistory: _formatRecentHistoryWithOrigin(recentMergedHistory),
        username: currentUsername,
        currentMessage: currentMessage,
    };
}

/**
 * Formats recent history with channel origin markers.
 * @param {Array} messages - Array of message objects with originChannel property.
 * @returns {string} Formatted chat history.
 */
function _formatRecentHistoryWithOrigin(messages) {
    if (!messages || messages.length === 0) {
        return "No recent messages.";
    }
    return messages.map(msg => {
        const channelMarker = msg.originChannel ? `[${msg.originChannel}] ` : '';
        const base = `${channelMarker}${msg.username}: ${msg.message}`;
        return msg.emoteContext ? `${base} ${msg.emoteContext}` : base;
    }).join('\n');
}

/**
 * Lazily fetches and caches the broadcaster ID for a channel name.
 * @param {string} channelName - Channel name (without '#').
 * @returns {Promise<string | null>} Broadcaster user ID, or null if lookup fails.
 */
async function getBroadcasterId(channelName) {
    const state = _getOrCreateChannelState(channelName);
    if (state.broadcasterId) {
        logger.debug(`[${channelName}] Using cached broadcaster ID: ${state.broadcasterId}`);
        return state.broadcasterId;
    }

    logger.info(`[${channelName}] Broadcaster ID not cached. Attempting fetch via Helix...`);

    try {
        // Call getUsersByLogin directly - it handles the Helix client internally
        const users = await getUsersByLogin([channelName]);

        logger.debug({ channel: channelName, userCount: users?.length, usersData: users }, `[${channelName}] Received response from getUsersByLogin.`);

        if (users && users.length > 0 && users[0].id) {
            state.broadcasterId = users[0].id;
            logger.info(`[${channelName}] Successfully fetched and cached broadcaster ID: ${state.broadcasterId}`);
            return state.broadcasterId;
        } else {
            logger.error(`[${channelName}] Could not find broadcaster ID in Helix response for login name.`);
            return null;
        }
    } catch (error) {
        logger.error({ err: { message: error.message, code: error.code }, channel: channelName }, `[${channelName}] Error during getUsersByLogin call.`);
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
    const idFetchPromises = [];

    // Use a Set to avoid duplicate fetches if channelStates has duplicates (shouldn't happen with Map)
    const channelsNeedingId = new Set();

    for (const channelName of channelStates.keys()) {
        const state = channelStates.get(channelName);
        if (state.broadcasterId) {
            channelsToPoll.push({ channelName: state.channelName, broadcasterId: state.broadcasterId });
        } else {
            // Only add if not already trying to fetch
            if (!channelsNeedingId.has(channelName)) {
                channelsNeedingId.add(channelName);
                // --- Added Debugging ---
                logger.debug(`[${channelName}] Adding promise to fetch missing broadcaster ID.`);
                // --- End Added Debugging ---
                idFetchPromises.push(
                    getBroadcasterId(channelName).then(id => {
                        if (id) {
                            // Add to list *after* successful fetch
                            channelsToPoll.push({ channelName: channelName, broadcasterId: id });
                        }
                        // Remove from set regardless of success/failure to prevent retries *within this cycle*
                        channelsNeedingId.delete(channelName);
                    }).catch(err => {
                        // Log errors from the getBroadcasterId promise itself
                        logger.error({ err, channel: channelName }, `[${channelName}] Error resolving getBroadcasterId promise in getChannelsForPolling.`);
                        channelsNeedingId.delete(channelName);
                    })
                );
            }
        }
    }

    // Wait for all fetches initiated in *this cycle* to complete
    if (idFetchPromises.length > 0) {
        logger.debug(`Waiting for ${idFetchPromises.length} broadcaster ID fetches to complete...`);
        await Promise.all(idFetchPromises);
        logger.debug(`Broadcaster ID fetches completed for this cycle.`);
    }

    // Return the list which now includes any IDs fetched successfully during this call
    return channelsToPoll;
}

/**
 * Enables translation mode for a user in a channel.
 * @param {string} channelName - Channel name (without '#').
 * @param {string} username - Username (lowercase).
 * @param {string} language - Target language.
 */
function enableUserTranslation(channelName, username, language) {
    const userState = _getOrCreateUserState(channelName, username);
    userState.isTranslating = true;
    userState.targetLanguage = language;
    logger.info(`[${channelName}] Enabled translation to ${language} for user ${username}`);
    // Persist to Firestore (fire-and-forget)
    saveUserTranslation(channelName, username, language).catch(err =>
        logger.error({ err }, `[${channelName}] Failed to persist translation for ${username}`)
    );
}

/**
 * Disables translation mode for a user in a channel.
 * @param {string} channelName - Channel name (without '#').
 * @param {string} username - Username (lowercase).
 */
function disableUserTranslation(channelName, username) {
    const userState = _getOrCreateUserState(channelName, username);
    if (userState.isTranslating) {
        userState.isTranslating = false;
        userState.targetLanguage = null;
        logger.info(`[${channelName}] Disabled translation for user ${username}`);
        // Remove from Firestore (fire-and-forget)
        removeUserTranslation(channelName, username).catch(err =>
            logger.error({ err }, `[${channelName}] Failed to remove translation for ${username}`)
        );
        return true; // Indicate that translation was disabled
    }
    return false; // Indicate translation was already off
}

/**
 * Gets the current translation state for a user.
 * @param {string} channelName - Channel name (without '#').
 * @param {string} username - Username (lowercase).
 * @returns {UserState | null} The user's state or null if not found (shouldn't happen with getOrCreate).
 */
function getUserTranslationState(channelName, username) {
    const channelState = channelStates.get(channelName); // Only check existing channels
    if (!channelState) return null;
    return channelState.userStates.get(username.toLowerCase()) || null; // Return null if user state doesn't exist yet
}

/**
 * Sets the bot's language for responses in a specific channel.
 * @param {string} channelName - Channel name (without '#').
 * @param {string} language - Target language (null to use default English).
 * @returns {Promise<boolean>} True if language was set, false if channel not found.
 */
async function setBotLanguage(channelName, language) {
    const channelState = channelStates.get(channelName);
    if (!channelState) {
        logger.warn(`[${channelName}] Attempted to set bot language, but channel not found.`);
        return false;
    }
    // If language is explicitly null or 'english' or 'default', reset to no translation
    if (language === null || language.toLowerCase() === 'english' || language.toLowerCase() === 'default') {
        channelState.botLanguage = null;
        logger.info(`[${channelName}] Bot language reset to default (English)`);
    } else {
        channelState.botLanguage = language;
        logger.info(`[${channelName}] Bot language set to: ${language}`);
    }
    // Save to Firestore
    try {
        await saveChannelLanguage(channelName, channelState.botLanguage);
    } catch (error) {
        logger.error({ err: error }, `Error saving language setting to Firestore for ${channelName}`);
        // Continue even if saving fails - at least memory state is updated
    }
    return true;
}

/**
 * Gets the bot's configured language for a specific channel.
 * @param {string} channelName - Channel name (without '#').
 * @returns {string|null} The configured language or null if none/default.
 */
function getBotLanguage(channelName) {
    const channelState = channelStates.get(channelName);
    if (!channelState) {
        logger.debug(`[${channelName}] Attempted to get bot language, but channel not found.`);
        return null;
    }
    return channelState.botLanguage;
}

/**
 * Disables translation for ALL users currently tracked in a specific channel.
 * @param {string} channelName - Channel name (without '#').
 * @returns {number} The number of users whose translation was disabled.
 */
function disableAllTranslationsInChannel(channelName) {
    const channelState = channelStates.get(channelName); // Get existing state
    if (!channelState || !channelState.userStates || channelState.userStates.size === 0) {
        logger.debug(`[${channelName}] No user states found to disable all translations.`);
        return 0; // Nothing to disable
    }

    let disabledCount = 0;
    for (const userState of channelState.userStates.values()) {
        if (userState.isTranslating) {
            userState.isTranslating = false;
            userState.targetLanguage = null;
            disabledCount++;
            logger.debug(`[${channelName}] Disabled translation for user ${userState.username} via global stop.`);
            // Remove from Firestore (fire-and-forget)
            removeUserTranslation(channelName, userState.username).catch(err =>
                logger.error({ err }, `[${channelName}] Failed to remove translation for ${userState.username}`)
            );
        }
    }

    if (disabledCount > 0) {
        logger.info(`[${channelName}] Disabled translation globally for ${disabledCount} users.`);
    } else {
        logger.info(`[${channelName}] Global translation stop requested, but no users had translation enabled.`);
    }
    return disabledCount;
}

/**
 * Gets all channel states for keep-alive checks.
 * @returns {Map<string, ChannelState>} Map of channel names to their states.
 */
function getAllChannelStates() {
    return new Map(channelStates);
}

/**
 * Returns a shallow snapshot of the current streamContext for a channel.
 * @param {string} channelName
 * @returns {StreamContext | null}
 */
function getStreamContextSnapshot(channelName) {
    const state = channelStates.get(channelName);
    if (!state) return null;
    return { ...state.streamContext };
}

// Define what the "manager" object exposes
const manager = {
    initialize: initializeContextManager,
    addMessage: addMessage,
    updateStreamContext: updateStreamContext,
    recordStreamContextFetchError: recordStreamContextFetchError,
    recordOfflineMiss: recordOfflineMiss,
    getContextForLLM: getContextForLLM,
    getMergedContextForLLM: getMergedContextForLLM,
    getStreamContextSnapshot,
    getBroadcasterId: getBroadcasterId,
    getChannelsForPolling: getChannelsForPolling,
    enableUserTranslation,
    disableUserTranslation,
    getUserTranslationState,
    disableAllTranslationsInChannel,
    setBotLanguage,
    getBotLanguage,
    clearStreamContext,
    clearThematicContext,
    getAllChannelStates,
};

/**
 * Gets the singleton Context Manager instance/interface.
 */
function getContextManager() {
    return manager;
}

export {
    initializeContextManager,
    getContextManager,
    getUserTranslationState,
    disableUserTranslation,
    disableAllTranslationsInChannel,
    setBotLanguage,
    getBotLanguage,
    clearStreamContext,
    clearThematicContext,
};
