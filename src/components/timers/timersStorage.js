// src/components/timers/timersStorage.js
// Firestore persistence for per-channel timed messages ("timers").
//
// Document contract is duplicated in the web UI repo:
//   chatsage-web-ui/functions/src/api/timers.router.ts
// Keep field names, defaults, and validation limits in sync between the two.
//
// Layout: channelTimers/{channelLogin}/timers/{timerName}
// The top-level collection is named 'channelTimers' (not 'timers') so the
// collectionGroup('timers') listener below only matches the subcollections.

import { getFirestore, FieldValue } from '../../lib/firestore.js';
import logger from '../../lib/logger.js';

const CHANNEL_TIMERS_COLLECTION = 'channelTimers';
const TIMERS_SUBCOLLECTION = 'timers';

// ─── Shared limits (mirrored in the web UI router) ──────────────────────────
export const MIN_INTERVAL_MINUTES = 2;
export const MAX_INTERVAL_MINUTES = 1440;
export const DEFAULT_INTERVAL_MINUTES = 15;
export const DEFAULT_MIN_CHAT_LINES = 5;
export const MAX_MIN_CHAT_LINES = 100;
export const MAX_TIMERS_PER_CHANNEL = 20;
export const MAX_RESPONSE_LENGTH = 500;
export const TIMER_NAME_REGEX = /^[a-z0-9_]{1,25}$/;
export const RESERVED_TIMER_NAMES = [
    'add', 'addai', 'edit', 'remove', 'delete', 'show', 'list',
    'interval', 'lines', 'enable', 'disable', 'options', 'help',
];

// Variables that depend on a triggering user and therefore can't be resolved
// when a timer fires on its own. Rejected at save time (chat handler + web UI).
const UNSUPPORTED_TIMER_VARIABLES = [
    /\$\(user\)/i,
    /\$\(args\)/i,
    /\$\(\d+\)/,
    /\$\(followage\)/i,
    /\$\(pronouns?\)/i,
    /\$\(pronoun_[a-z]+\)/i,
    /\$\(checkin_count\)/i,
];

/**
 * Custom error class for timers storage operations.
 */
export class TimersStorageError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'TimersStorageError';
        this.cause = cause;
    }
}

/**
 * Returns the user-dependent $(...) variables found in a timer template.
 * Timers fire without a triggering user, so these can never resolve.
 * @param {string} template - The timer response template.
 * @returns {string[]} The offending variable tokens (empty if none).
 */
export function findUnsupportedTimerVariables(template) {
    if (!template || typeof template !== 'string') return [];
    const offenders = [];
    const variablePattern = /\$\([^)]+\)/g;
    const matches = template.match(variablePattern) || [];
    for (const token of matches) {
        if (UNSUPPORTED_TIMER_VARIABLES.some(re => re.test(token)) && !offenders.includes(token)) {
            offenders.push(token);
        }
    }
    return offenders;
}

/** @returns {import('@google-cloud/firestore').Firestore} */
export function _getDb() {
    return getFirestore();
}

function _timerDocRef(db, channelName, timerName) {
    return db.collection(CHANNEL_TIMERS_COLLECTION)
        .doc(channelName.toLowerCase())
        .collection(TIMERS_SUBCOLLECTION)
        .doc(timerName.toLowerCase());
}

/**
 * Gets a single timer for a channel.
 * @param {string} channelName - The channel name (lowercase).
 * @param {string} timerName - The timer name (lowercase).
 * @returns {Promise<object|null>} Timer data or null if not found.
 */
export async function getTimer(channelName, timerName) {
    const db = _getDb();
    try {
        const docSnap = await _timerDocRef(db, channelName, timerName).get();
        if (docSnap.exists) {
            return { name: timerName.toLowerCase(), ...docSnap.data() };
        }
        return null;
    } catch (error) {
        logger.error({ err: error, channel: channelName, timer: timerName },
            '[TimersStorage] Error getting timer');
        throw new TimersStorageError(`Failed to get timer ${timerName} for ${channelName}`, error);
    }
}

/**
 * Gets all timers for a channel.
 * @param {string} channelName - The channel name (lowercase).
 * @returns {Promise<object[]>} Array of timer objects.
 */
export async function getTimersForChannel(channelName) {
    const db = _getDb();
    const colRef = db.collection(CHANNEL_TIMERS_COLLECTION)
        .doc(channelName.toLowerCase())
        .collection(TIMERS_SUBCOLLECTION);

    try {
        const snapshot = await colRef.get();
        const timers = [];
        snapshot.forEach(doc => {
            timers.push({ name: doc.id, ...doc.data() });
        });
        return timers;
    } catch (error) {
        logger.error({ err: error, channel: channelName },
            '[TimersStorage] Error loading timers');
        throw new TimersStorageError(`Failed to load timers for ${channelName}`, error);
    }
}

/**
 * Adds a new timer for a channel.
 * @param {string} channelName - The channel name (lowercase).
 * @param {string} timerName - The timer name (lowercase).
 * @param {string} response - The message template or AI prompt.
 * @param {string} createdBy - Username of the creator.
 * @param {string} [type='text'] - The timer type ('text' or 'prompt').
 * @param {number} [intervalMinutes] - Firing interval in minutes.
 * @param {number} [minChatLines] - Chat lines required since last fire.
 * @returns {Promise<boolean>} True if created, false if the timer already exists.
 */
export async function addTimer(channelName, timerName, response, createdBy, type = 'text',
    intervalMinutes = DEFAULT_INTERVAL_MINUTES, minChatLines = DEFAULT_MIN_CHAT_LINES) {
    const db = _getDb();
    const lowerChannel = channelName.toLowerCase();
    const lowerTimer = timerName.toLowerCase();
    const docRef = _timerDocRef(db, lowerChannel, lowerTimer);

    try {
        const existing = await docRef.get();
        if (existing.exists) {
            logger.debug(`[TimersStorage] Timer ${lowerTimer} already exists in channel ${lowerChannel}`);
            return false;
        }

        const countSnap = await db.collection(CHANNEL_TIMERS_COLLECTION)
            .doc(lowerChannel)
            .collection(TIMERS_SUBCOLLECTION)
            .count()
            .get();
        if (countSnap.data().count >= MAX_TIMERS_PER_CHANNEL) {
            throw new TimersStorageError(`Channel ${lowerChannel} already has the maximum of ${MAX_TIMERS_PER_CHANNEL} timers`);
        }

        await docRef.set({
            response,
            type,
            intervalMinutes,
            minChatLines,
            enabled: true,
            useCount: 0,
            lastRunAt: null,
            createdBy: createdBy.toLowerCase(),
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
        });

        // Also set the parent doc to ensure it exists for queries
        await db.collection(CHANNEL_TIMERS_COLLECTION)
            .doc(lowerChannel)
            .set({ channelName: lowerChannel, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

        logger.info(`[TimersStorage] Added timer ${lowerTimer} for channel ${lowerChannel} (type: ${type}, every ${intervalMinutes}m)`);
        return true;
    } catch (error) {
        if (error instanceof TimersStorageError) throw error;
        logger.error({ err: error, channel: lowerChannel, timer: lowerTimer },
            '[TimersStorage] Error adding timer');
        throw new TimersStorageError(`Failed to add timer ${lowerTimer} for ${lowerChannel}`, error);
    }
}

/**
 * Updates an existing timer's response.
 * @param {string} channelName - The channel name (lowercase).
 * @param {string} timerName - The timer name (lowercase).
 * @param {string} response - The new message template or AI prompt.
 * @returns {Promise<boolean>} True if updated, false if the timer doesn't exist.
 */
export async function updateTimerResponse(channelName, timerName, response) {
    const db = _getDb();
    const docRef = _timerDocRef(db, channelName, timerName);

    try {
        const existing = await docRef.get();
        if (!existing.exists) {
            return false;
        }

        await docRef.update({
            response,
            updatedAt: FieldValue.serverTimestamp(),
        });

        logger.info(`[TimersStorage] Updated timer ${timerName.toLowerCase()} for channel ${channelName.toLowerCase()}`);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, timer: timerName },
            '[TimersStorage] Error updating timer');
        throw new TimersStorageError(`Failed to update timer ${timerName} for ${channelName}`, error);
    }
}

/**
 * Updates options for a timer.
 * @param {string} channelName - The channel name.
 * @param {string} timerName - The timer name.
 * @param {object} options - Options to update.
 * @param {number} [options.intervalMinutes] - Firing interval in minutes.
 * @param {number} [options.minChatLines] - Chat lines required since last fire.
 * @param {boolean} [options.enabled] - Whether the timer is active.
 * @param {string} [options.type] - Timer type ('text' or 'prompt').
 * @returns {Promise<boolean>} True if updated, false if the timer doesn't exist.
 */
export async function updateTimerOptions(channelName, timerName, options) {
    const db = _getDb();
    const docRef = _timerDocRef(db, channelName, timerName);

    try {
        const existing = await docRef.get();
        if (!existing.exists) {
            return false;
        }

        const updateData = { updatedAt: FieldValue.serverTimestamp() };
        if (options.intervalMinutes !== undefined) {
            updateData.intervalMinutes = options.intervalMinutes;
        }
        if (options.minChatLines !== undefined) {
            updateData.minChatLines = options.minChatLines;
        }
        if (options.enabled !== undefined) {
            updateData.enabled = options.enabled;
        }
        if (options.type !== undefined) {
            updateData.type = options.type;
        }

        await docRef.update(updateData);

        logger.info(`[TimersStorage] Updated options for timer ${timerName.toLowerCase()} in ${channelName.toLowerCase()}: ${JSON.stringify(options)}`);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, timer: timerName },
            '[TimersStorage] Error updating timer options');
        throw new TimersStorageError(`Failed to update options for ${timerName} in ${channelName}`, error);
    }
}

/**
 * Removes a timer from a channel.
 * @param {string} channelName - The channel name (lowercase).
 * @param {string} timerName - The timer name (lowercase).
 * @returns {Promise<boolean>} True if removed, false if the timer didn't exist.
 */
export async function removeTimer(channelName, timerName) {
    const db = _getDb();
    const docRef = _timerDocRef(db, channelName, timerName);

    try {
        const existing = await docRef.get();
        if (!existing.exists) {
            return false;
        }

        await docRef.delete();

        logger.info(`[TimersStorage] Removed timer ${timerName.toLowerCase()} from channel ${channelName.toLowerCase()}`);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, timer: timerName },
            '[TimersStorage] Error removing timer');
        throw new TimersStorageError(`Failed to remove timer ${timerName} from ${channelName}`, error);
    }
}

/**
 * Records a successful timer fire. Fire-and-forget — errors are logged, never thrown.
 * @param {string} channelName - The channel name.
 * @param {string} timerName - The timer name.
 */
export async function recordTimerRun(channelName, timerName) {
    const db = _getDb();
    try {
        await _timerDocRef(db, channelName, timerName).update({
            lastRunAt: FieldValue.serverTimestamp(),
            useCount: FieldValue.increment(1),
        });
    } catch (error) {
        logger.warn({ err: error, channel: channelName, timer: timerName },
            '[TimersStorage] Error recording timer run');
    }
}

/**
 * Loads all timers for all channels. Used for in-memory cache initialization.
 * @returns {Promise<Map<string, Map<string, object>>>} Map of channelName -> Map of timerName -> timer data.
 */
export async function loadAllTimers() {
    const db = _getDb();

    try {
        const snapshot = await db.collectionGroup(TIMERS_SUBCOLLECTION).get();
        const allTimers = new Map();

        snapshot.forEach(doc => {
            const channelName = doc.ref.parent.parent?.id;
            if (!channelName) return;
            if (!allTimers.has(channelName)) {
                allTimers.set(channelName, new Map());
            }
            allTimers.get(channelName).set(doc.id, { name: doc.id, ...doc.data() });
        });

        logger.info(`[TimersStorage] Loaded timers for ${allTimers.size} channels`);
        return allTimers;
    } catch (error) {
        logger.error({ err: error }, '[TimersStorage] Error loading all timers');
        throw new TimersStorageError('Failed to load all timers', error);
    }
}

/**
 * Sets up a real-time listener for timer changes across all channels,
 * so web-UI edits apply without a bot restart.
 * @param {Function} onChangeCallback - Called per change with
 *        ({ type: 'added'|'modified'|'removed', channelName, timerName, timer }).
 * @returns {Function} Unsubscribe function to stop listening for changes.
 */
export function listenForTimerChanges(onChangeCallback) {
    const db = _getDb();

    logger.info('[TimersStorage] Setting up listener for timer changes...');

    const unsubscribe = db.collectionGroup(TIMERS_SUBCOLLECTION)
        .onSnapshot(snapshot => {
            snapshot.docChanges().forEach(change => {
                const channelName = change.doc.ref.parent.parent?.id;
                if (!channelName) {
                    logger.warn({ docId: change.doc.id },
                        '[TimersStorage] Listener detected timer doc without a parent channel. Skipping.');
                    return;
                }
                onChangeCallback({
                    type: change.type,
                    channelName,
                    timerName: change.doc.id,
                    timer: { name: change.doc.id, ...change.doc.data() },
                });
            });
        }, error => {
            logger.error({ err: error }, '[TimersStorage] Error in timer changes listener.');
        });

    logger.info('[TimersStorage] Timer changes listener set up successfully.');

    return unsubscribe;
}
