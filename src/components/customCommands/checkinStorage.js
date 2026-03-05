// src/components/customCommands/checkinStorage.js
import { FieldValue } from '@google-cloud/firestore';
import logger from '../../lib/logger.js';
import { _getDb } from './customCommandsStorage.js';

// Collection name for storing per-channel custom commands
const CUSTOM_COMMANDS_COLLECTION = 'customCommands';

/**
 * Gets the checkin config document reference for a channel.
 * Path: customCommands/{channelName}/checkinConfig/settings
 */
function _getCheckinConfigRef(channelName) {
    const db = _getDb();
    return db.collection(CUSTOM_COMMANDS_COLLECTION)
        .doc(channelName.toLowerCase())
        .collection('checkinConfig')
        .doc('settings');
}

/**
 * Gets the userCounters collection reference for a channel.
 * Path: customCommands/{channelName}/checkinCounters/{userId}
 */
function _getUserCountersRef(channelName) {
    const db = _getDb();
    return db.collection(CUSTOM_COMMANDS_COLLECTION)
        .doc(channelName.toLowerCase())
        .collection('checkinCounters');
}

// ─── Config Operations ───────────────────────────────────────────────────────

/**
 * Gets the check-in configuration for a channel.
 * @param {string} channelName - Channel name.
 * @returns {Promise<object|null>} Config object or null if not configured.
 */
export async function getCheckinConfig(channelName) {
    try {
        const docSnap = await _getCheckinConfigRef(channelName).get();
        if (!docSnap.exists) return null;
        return docSnap.data();
    } catch (error) {
        logger.error({ err: error, channel: channelName },
            '[CheckinStorage] Error getting check-in config');
        return null;
    }
}

/**
 * Saves or updates the check-in configuration for a channel.
 * @param {string} channelName - Channel name.
 * @param {object} config - Configuration fields (rewardId, responseTemplate, useAi, aiPrompt, enabled).
 * @returns {Promise<boolean>} True if saved successfully.
 */
export async function saveCheckinConfig(channelName, config) {
    try {
        await _getCheckinConfigRef(channelName).set({
            ...config,
            updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        logger.info({ channel: channelName, config }, '[CheckinStorage] Saved check-in config');
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName },
            '[CheckinStorage] Error saving check-in config');
        return false;
    }
}

// ─── Counter Operations ─────────────────────────────────────────────────────

/**
 * Records a check-in for a user. Atomically increments their counter.
 * @param {string} channelName - Channel name.
 * @param {string} userId - Twitch user ID.
 * @param {string} displayName - User's display name (for readability in Firestore).
 * @returns {Promise<{count: number, isNew: boolean}>} The new count and whether this was first check-in.
 */
export async function recordCheckin(channelName, userId, displayName) {
    try {
        const docRef = _getUserCountersRef(channelName).doc(userId);
        const docSnap = await docRef.get();
        const isNew = !docSnap.exists;

        await docRef.set({
            count: FieldValue.increment(1),
            lastCheckin: FieldValue.serverTimestamp(),
            displayName: displayName || userId,
        }, { merge: true });

        // Read back the new count
        const updated = await docRef.get();
        const newCount = updated.data()?.count || 1;

        logger.debug({
            channel: channelName,
            userId,
            displayName,
            count: newCount,
            isNew,
        }, '[CheckinStorage] Recorded check-in');

        return { count: newCount, isNew };
    } catch (error) {
        logger.error({ err: error, channel: channelName, userId },
            '[CheckinStorage] Error recording check-in');
        // Return a fallback so the command can still produce a response
        return { count: 0, isNew: true };
    }
}

/**
 * Gets a user's current check-in count without modifying it.
 * @param {string} channelName - Channel name.
 * @param {string} userId - Twitch user ID.
 * @returns {Promise<number>} The current count, or 0 if not found.
 */
export async function getCheckinCount(channelName, userId) {
    try {
        const docRef = _getUserCountersRef(channelName).doc(userId);
        const docSnap = await docRef.get();

        if (!docSnap.exists) return 0;
        return docSnap.data()?.count || 0;
    } catch (error) {
        logger.error({ err: error, channel: channelName, userId },
            '[CheckinStorage] Error getting check-in count');
        return 0;
    }
}
