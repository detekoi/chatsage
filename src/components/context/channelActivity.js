// src/components/context/channelActivity.js
// Shared per-channel chat activity tracker. Single source of truth for
// "when did chat last speak" (used by auto-chat lull detection) and
// "how many messages have been seen" (used by timer min-chat-lines gating).

const activity = new Map(); // channelName -> { lastMessageAtMs, messageCount }

function getState(channelName) {
    const key = channelName.toLowerCase();
    if (!activity.has(key)) {
        activity.set(key, { lastMessageAtMs: 0, messageCount: 0 });
    }
    return activity.get(key);
}

/**
 * Records a user chat message for a channel.
 * @param {string} channelName - Channel name (without #).
 * @param {number} [timestampMs] - Message timestamp, defaults to now.
 */
export function recordChatMessage(channelName, timestampMs = Date.now()) {
    const state = getState(channelName);
    state.lastMessageAtMs = Math.max(state.lastMessageAtMs, timestampMs || Date.now());
    state.messageCount += 1;
}

/**
 * @param {string} channelName - Channel name (without #).
 * @returns {number} Timestamp (ms) of the last user message, or 0 if none seen.
 */
export function getLastMessageAt(channelName) {
    return activity.get(channelName.toLowerCase())?.lastMessageAtMs || 0;
}

/**
 * @param {string} channelName - Channel name (without #).
 * @returns {number} Monotonic count of user messages seen since process start.
 */
export function getMessageCount(channelName) {
    return activity.get(channelName.toLowerCase())?.messageCount || 0;
}

/**
 * Seeds the last-message timestamp from persisted chat history at startup
 * without affecting the message counter.
 * @param {string} channelName - Channel name (without #).
 * @param {number} timestampMs - Timestamp of the most recent known message.
 */
export function seedLastMessageAt(channelName, timestampMs) {
    const state = getState(channelName);
    state.lastMessageAtMs = Math.max(state.lastMessageAtMs, timestampMs || 0);
}

// Exported for testing only
export function _reset() {
    activity.clear();
}
