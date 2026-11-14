// src/components/context/responseStyleStorage.js
//
// Per-channel response style switches. Today there is one: De-Slop, which adds
// the plain-writing rules in src/lib/deslop.js to the channel's prompts.
//
// Kept apart from channelPersonas because the dashboard's "Reset to default"
// deletes the persona document, and that must not turn this switch off.
//
// Same shape as personaStorage.js, and for the same reason: the prompt builders
// are synchronous and run on every message, so the setting is hydrated at boot
// and kept fresh by an onSnapshot listener.

import { getFirestore } from '../../lib/firestore.js';
import { getBroadcasterIdForChannel } from '../../lib/allowList.js';
import { channelDocKey, normalizeChannelName } from '../../lib/channelKey.js';
import logger from '../../lib/logger.js';

const RESPONSE_STYLE_COLLECTION = 'channelResponseStyles';

// Broadcaster IDs of the channels with De-Slop on. Off is the default, so a
// channel with no document is simply absent.
const deslopChannels = new Set();

/** @returns {import('@google-cloud/firestore').Firestore} */
function _getDb() {
    return getFirestore();
}

/**
 * Whether a document turns De-Slop on. Only a literal true counts, because a
 * document can be edited directly in Firestore.
 * @param {object} data - Raw Firestore document data.
 * @returns {boolean}
 */
export function normalizeDeslop(data) {
    return !!data && typeof data === 'object' && data.deslop === true;
}

/**
 * Loads every channel's response style into the in-memory cache.
 * @returns {Promise<number>} Number of channels with De-Slop on.
 */
export async function loadAllResponseStyles() {
    try {
        const snapshot = await _getDb().collection(RESPONSE_STYLE_COLLECTION).get();
        deslopChannels.clear();
        snapshot.forEach(doc => {
            if (normalizeDeslop(doc.data())) deslopChannels.add(doc.id);
        });
        logger.info(`[ResponseStyleStorage] Loaded ${deslopChannels.size} channels with De-Slop on`);
    } catch (err) {
        logger.error({ err }, '[ResponseStyleStorage] Error loading response styles');
    }
    return deslopChannels.size;
}

/**
 * Synchronous cache read by broadcaster ID.
 * @param {string} twitchUserId
 * @returns {boolean}
 */
export function isDeslopEnabledById(twitchUserId) {
    if (!twitchUserId) return false;
    return deslopChannels.has(String(twitchUserId));
}

/**
 * Synchronous cache read by channel login name. A channel with no known
 * broadcaster ID reads as off, which leaves its prompts unchanged.
 * @param {string} channelName - Channel name, with or without '#'.
 * @returns {boolean}
 */
export function isDeslopEnabled(channelName) {
    if (!channelName) return false;
    const id = getBroadcasterIdForChannel(normalizeChannelName(channelName));
    return id ? isDeslopEnabledById(id) : false;
}

/**
 * Turns De-Slop on or off for a channel and updates the cache.
 * @param {string} channelName - Channel name, with or without '#'.
 * @param {boolean} enabled
 * @returns {Promise<void>}
 * @throws When the channel has no known broadcaster ID or the write fails.
 */
export async function setDeslopEnabled(channelName, enabled) {
    const login = normalizeChannelName(channelName);
    const key = channelDocKey(login);
    const deslop = enabled === true;

    await _getDb().collection(RESPONSE_STYLE_COLLECTION).doc(key).set(
        { deslop, channelName: login, updatedAt: new Date() },
        { merge: true },
    );

    if (deslop) {
        deslopChannels.add(key);
    } else {
        deslopChannels.delete(key);
    }
}

/**
 * Real-time listener for response style changes. The callback runs only when a
 * channel's effective setting changes, so the bot's own write (already applied
 * to the cache by setDeslopEnabled) and unrelated field updates are ignored.
 *
 * @param {(change: {twitchUserId: string, deslop: boolean}) => void} callback
 * @returns {Function} Unsubscribe function.
 */
export function onResponseStyleChanges(callback) {
    return _getDb().collection(RESPONSE_STYLE_COLLECTION).onSnapshot(snapshot => {
        snapshot.docChanges().forEach(change => {
            const twitchUserId = change.doc.id;
            const deslop = change.type === 'removed' ? false : normalizeDeslop(change.doc.data());
            if (deslop === deslopChannels.has(twitchUserId)) return;

            if (deslop) {
                deslopChannels.add(twitchUserId);
            } else {
                deslopChannels.delete(twitchUserId);
            }

            try {
                callback({ twitchUserId, deslop });
            } catch (err) {
                logger.error({ err, twitchUserId }, '[ResponseStyleStorage] Response style change callback failed');
            }
        });
    }, err => {
        logger.error({ err }, '[ResponseStyleStorage] Response style listener error');
    });
}

/** Test seam: clears the in-memory cache. */
export function _clearResponseStyleCache() {
    deslopChannels.clear();
}
