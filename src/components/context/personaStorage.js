// src/components/context/personaStorage.js
//
// Per-channel custom system-instruction personas, authored from the dashboard
// and screened by a safety check before they are ever written here.
//
// Keyed by Twitch broadcaster ID rather than login name. Every sibling config
// collection uses the login name, which Twitch lets users change and eventually
// releases for re-registration — so a name-keyed doc both orphans on rename and
// can be inherited by whoever claims the freed name. That is tolerable for a
// timer; for text that gets composed into a system instruction it is not.
//
// The cache is hydrated at boot and kept fresh by an onSnapshot listener,
// because buildSystemInstruction() is synchronous and runs on every message —
// there is no room for a Firestore read on that path.

import crypto from 'crypto';
import { getFirestore } from '../../lib/firestore.js';
import { getBroadcasterIdForChannel } from '../../lib/allowList.js';
import logger from '../../lib/logger.js';

const PERSONA_COLLECTION = 'channelPersonas';
const BOT_DEFAULTS_COLLECTION = 'botDefaults';
const BOT_DEFAULTS_DOC = 'persona';

export const MAX_PERSONA_LENGTH = 2000;

// Broadcaster ID → persona instruction text. Only approved personas land here.
const personaCache = new Map();

/**
 * No-op – Firestore is now initialized centrally via initializeFirestore() in initComponents.js.
 */
export async function initializePersonaStorage() {
    logger.debug('[PersonaStorage] Using shared Firestore client.');
}

/** @returns {import('@google-cloud/firestore').Firestore} */
function _getDb() {
    return getFirestore();
}

/**
 * Extracts the usable persona text from a document, or null if it should not be
 * applied. Length is re-clamped here because a document can be edited directly
 * in Firestore, outside the API that normally enforces the limit.
 * @param {object} data - Raw Firestore document data.
 * @returns {string|null}
 */
export function normalizePersona(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.status !== 'approved') return null;
    const text = typeof data.instructions === 'string' ? data.instructions.trim() : '';
    if (!text) return null;
    return text.slice(0, MAX_PERSONA_LENGTH);
}

/**
 * Loads every approved persona into the in-memory cache.
 * @returns {Promise<Map<string, string>>} Broadcaster ID → persona text.
 */
export async function loadAllChannelPersonas() {
    try {
        const snapshot = await _getDb().collection(PERSONA_COLLECTION).get();
        personaCache.clear();
        snapshot.forEach(doc => {
            const persona = normalizePersona(doc.data());
            if (persona) personaCache.set(doc.id, persona);
        });
        logger.info(`[PersonaStorage] Loaded ${personaCache.size} custom channel personas`);
        return personaCache;
    } catch (err) {
        logger.error({ err }, '[PersonaStorage] Error loading channel personas');
        return personaCache;
    }
}

/**
 * Synchronous cache read by broadcaster ID.
 * @param {string} twitchUserId
 * @returns {string|null} Persona text, or null when the channel uses the default.
 */
export function getCachedPersonaById(twitchUserId) {
    if (!twitchUserId) return null;
    return personaCache.get(String(twitchUserId)) || null;
}

/**
 * Synchronous cache read by channel login name.
 *
 * A channel with no known broadcaster ID (a legacy managedChannels document
 * predating twitchUserId, or one not yet loaded) resolves to null and therefore
 * to the default persona, which is the safe direction to fail.
 *
 * @param {string} channelName - Channel name, with or without '#'.
 * @returns {string|null}
 */
export function getCachedPersona(channelName) {
    const id = getBroadcasterIdForChannel(channelName);
    return id ? getCachedPersonaById(id) : null;
}

/**
 * Real-time listener for persona changes. The callback receives a broadcaster
 * ID; callers resolve it back to a channel name themselves, since a change may
 * also invalidate shared-chat sessions that blended this persona.
 *
 * @param {(change: {type: string, twitchUserId: string, persona: string|null}) => void} callback
 * @returns {Function} Unsubscribe function.
 */
export function onPersonaChanges(callback) {
    const db = _getDb();
    return db.collection(PERSONA_COLLECTION).onSnapshot(snapshot => {
        snapshot.docChanges().forEach(change => {
            const twitchUserId = change.doc.id;
            const persona = change.type === 'removed' ? null : normalizePersona(change.doc.data());

            if (persona) {
                personaCache.set(twitchUserId, persona);
            } else {
                personaCache.delete(twitchUserId);
            }

            try {
                callback({ type: change.type, twitchUserId, persona });
            } catch (err) {
                logger.error({ err, twitchUserId }, '[PersonaStorage] Persona change callback failed');
            }
        });
    }, err => {
        logger.error({ err }, '[PersonaStorage] Persona listener error');
    });
}

/**
 * Publishes the bot's default persona and immutable core to Firestore so the
 * dashboard can show them without keeping its own copy of the text.
 *
 * The bot constants are the single source of truth; the two repos share no code
 * but do share Firestore, so that is the integration channel. Writes only when
 * the content hash changes, so ordinary restarts cost nothing.
 *
 * @param {string} persona - DEFAULT_BOT_PERSONA.
 * @param {string} core - BOT_CORE_INSTRUCTION.
 * @returns {Promise<boolean>} True if a write happened.
 */
export async function publishBotDefaults(persona, core) {
    const hash = crypto.createHash('sha256').update(`${persona}\n${core}`).digest('hex');

    try {
        const docRef = _getDb().collection(BOT_DEFAULTS_COLLECTION).doc(BOT_DEFAULTS_DOC);
        const snap = await docRef.get();
        if (snap.exists && snap.data()?.hash === hash) {
            logger.debug('[PersonaStorage] Bot defaults unchanged, skipping publish');
            return false;
        }

        await docRef.set({
            persona,
            core,
            hash,
            maxLength: MAX_PERSONA_LENGTH,
            updatedAt: new Date(),
        });
        logger.info({ hash: hash.slice(0, 12) }, '[PersonaStorage] Published bot defaults');
        return true;
    } catch (err) {
        // Non-fatal: the dashboard falls back to its bootstrap copy, and the bot
        // itself does not read this document.
        logger.error({ err }, '[PersonaStorage] Failed to publish bot defaults');
        return false;
    }
}

/** Test seam: clears the in-memory cache. */
export function _clearPersonaCache() {
    personaCache.clear();
}
