// src/components/twitch/sharedChatManager.js
import logger from '../../lib/logger.js';

/**
 * Manages shared chat session state for Twitch collab streams.
 * Tracks which channels are in shared chat sessions and provides lookup methods.
 */

// Map of sessionId -> session info
// Session info: { sessionId, hostChannelId, channels: Set<channelId>, participants: Array, updatedAt: Date }
const activeSessions = new Map();

// Map of channelId -> sessionId for quick lookup
const channelToSession = new Map();

/**
 * Adds or updates a shared chat session.
 * @param {string} sessionId - Unique session identifier
 * @param {string} hostChannelId - The host broadcaster's user ID
 * @param {Array} participants - Array of participant objects with broadcaster_user_id and broadcaster_user_login
 */
export function addSession(sessionId, hostChannelId, participants = []) {
    if (!sessionId || !hostChannelId) {
        logger.warn('addSession called with missing sessionId or hostChannelId');
        return;
    }

    const channelIds = new Set(participants.map(p => p.broadcaster_user_id));
    const channelLogins = participants.map(p => p.broadcaster_user_login);

    // Create or update session
    activeSessions.set(sessionId, {
        sessionId,
        hostChannelId,
        channels: channelIds,
        participants,
        updatedAt: new Date()
    });

    // Update channel-to-session mapping
    for (const channelId of channelIds) {
        channelToSession.set(channelId, sessionId);
    }

    logger.info({
        sessionId,
        hostChannelId,
        participantCount: channelIds.size,
        channels: channelLogins
    }, `Shared chat session added/updated: ${channelLogins.join(', ')}`);
}

/**
 * Updates an existing shared chat session with new participant list.
 * @param {string} sessionId - Unique session identifier
 * @param {Array} participants - Updated array of participant objects
 */
export function updateSession(sessionId, participants = []) {
    const session = activeSessions.get(sessionId);
    if (!session) {
        logger.warn({ sessionId }, 'updateSession called for non-existent session');
        return;
    }

    // Clear old channel mappings for this session
    for (const channelId of session.channels) {
        channelToSession.delete(channelId);
    }

    // Update session with new participants
    const channelIds = new Set(participants.map(p => p.broadcaster_user_id));
    const channelLogins = participants.map(p => p.broadcaster_user_login);

    session.channels = channelIds;
    session.participants = participants;
    session.updatedAt = new Date();

    // Re-add channel mappings
    for (const channelId of channelIds) {
        channelToSession.set(channelId, sessionId);
    }

    logger.info({
        sessionId,
        participantCount: channelIds.size,
        channels: channelLogins
    }, `Shared chat session updated: ${channelLogins.join(', ')}`);
}

/**
 * Removes a shared chat session and cleans up all mappings.
 * @param {string} sessionId - Unique session identifier
 */
export function removeSession(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session) {
        logger.debug({ sessionId }, 'removeSession called for non-existent session');
        return;
    }

    // Clear channel mappings
    for (const channelId of session.channels) {
        channelToSession.delete(channelId);
    }

    activeSessions.delete(sessionId);

    const channelLogins = session.participants.map(p => p.broadcaster_user_login);
    logger.info({
        sessionId,
        channels: channelLogins
    }, `Shared chat session removed: ${channelLogins.join(', ')}`);
}

/**
 * Gets the session ID for a given channel (by broadcaster user ID).
 * @param {string} channelId - Broadcaster user ID
 * @returns {string|null} Session ID if channel is in a shared session, null otherwise
 */
export function getSessionForChannel(channelId) {
    return channelToSession.get(channelId) || null;
}

/**
 * Gets all participating channel IDs in a shared session.
 * @param {string} sessionId - Unique session identifier
 * @returns {Set<string>|null} Set of broadcaster user IDs, or null if session doesn't exist
 */
export function getParticipatingChannels(sessionId) {
    const session = activeSessions.get(sessionId);
    return session ? new Set(session.channels) : null;
}

/**
 * Gets full session information.
 * @param {string} sessionId - Unique session identifier
 * @returns {object|null} Session object or null if not found
 */
export function getSession(sessionId) {
    return activeSessions.get(sessionId) || null;
}

/**
 * Gets all active sessions (for debugging/monitoring).
 * @returns {Map} Map of all active sessions
 */
export function getAllSessions() {
    return new Map(activeSessions);
}

/**
 * Checks if a channel is currently in a shared chat session.
 * @param {string} channelId - Broadcaster user ID
 * @returns {boolean} True if channel is in a shared session
 */
export function isInSharedSession(channelId) {
    return channelToSession.has(channelId);
}

/**
 * Gets the channel logins for all participants in a session (for logging/display).
 * @param {string} sessionId - Unique session identifier
 * @returns {string[]} Array of channel login names
 */
export function getSessionChannelLogins(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session) return [];
    return session.participants.map(p => p.broadcaster_user_login);
}

/**
 * Clears all sessions (useful for testing or restart scenarios).
 */
export function clearAllSessions() {
    activeSessions.clear();
    channelToSession.clear();
    logger.info('All shared chat sessions cleared');
}

