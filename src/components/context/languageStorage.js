// src/components/context/languageStorage.js
//
// Layout: channelLanguages/{broadcasterId} -> { channelName, language }
// Keyed by broadcaster ID, not login (see lib/channelKey.js). The web UI writes
// the same documents (chatsage-web-ui/functions/src/api/language.router.ts).
import { getFirestore } from '../../lib/firestore.js';
import { channelDocKey, channelNameForDocKey } from '../../lib/channelKey.js';
import logger from '../../lib/logger.js';

// Collection name
const LANGUAGE_COLLECTION = 'channelLanguages';

/**
 * Custom error class for language storage operations.
 */
export class LanguageStorageError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'LanguageStorageError';
        this.cause = cause;
    }
}

/**
 * No-op – Firestore is now initialized centrally via initializeFirestore() in initComponents.js.
 */
export async function initializeLanguageStorage() {
    logger.debug('[LanguageStorage] Using shared Firestore client.');
}

/** @returns {import('@google-cloud/firestore').Firestore} */
function _getDb() {
    return getFirestore();
}

function _channelDocRef(channelName) {
    return _getDb().collection(LANGUAGE_COLLECTION).doc(channelDocKey(channelName));
}

/**
 * Loads the language setting for a specific channel from Firestore.
 * @param {string} channelName
 * @returns {Promise<string|null>} The language setting or null if not found/default.
 */
export async function getChannelLanguage(channelName) {
    try {
        const docSnap = await _channelDocRef(channelName).get();
        if (docSnap.exists) {
            const data = docSnap.data();
            logger.debug(`[LanguageStorage] Loaded language setting for channel ${channelName}: ${data.language || 'default'}`);
            return data.language; // Can be null for default
        } else {
            logger.debug(`[LanguageStorage] No language setting found for channel ${channelName}, using default`);
            return null; // Not found is not an error
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `[LanguageStorage] Error loading language setting for channel ${channelName}`);
        throw new LanguageStorageError(`Failed to load language setting for ${channelName}`, error);
    }
}

/**
 * Saves or updates the language setting for a specific channel in Firestore.
 * @param {string} channelName
 * @param {string|null} language - The language to save (null for default English).
 * @returns {Promise<boolean>} True on success, false on failure.
 */
export async function saveChannelLanguage(channelName, language) {
    try {
        await _channelDocRef(channelName).set({
            channelName: channelName.toLowerCase(),
            language: language,
            updatedAt: new Date()
        }, { merge: true });
        logger.debug(`[LanguageStorage] Saved language setting for channel ${channelName}: ${language || 'default'}`);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `[LanguageStorage] Error saving language setting for channel ${channelName}`);
        throw new LanguageStorageError(`Failed to save language setting for ${channelName}`, error);
    }
}

/**
 * Loads all channel language settings from Firestore.
 * @returns {Promise<Map<string, string>>} Map of channel names to language settings.
 */
export async function loadAllChannelLanguages() {
    const db = _getDb();
    const colRef = db.collection(LANGUAGE_COLLECTION);
    try {
        const snapshot = await colRef.get();
        const channelLanguages = new Map();
        
        snapshot.forEach(doc => {
            const data = doc.data();
            const channelName = channelNameForDocKey(doc.id, data);
            if (!channelName) return;
            channelLanguages.set(channelName, data.language);
        });
        
        logger.info(`[LanguageStorage] Loaded language settings for ${channelLanguages.size} channels`);
        return channelLanguages;
    } catch (error) {
        logger.error({ err: error }, `[LanguageStorage] Error loading all channel language settings`);
        throw new LanguageStorageError('Failed to load all channel language settings', error);
    }
}

/**
 * Real-time listener for channel language changes.
 *
 * The dashboard writes this collection directly, so a running bot would otherwise keep the value
 * it read at boot until the next restart. The callback receives `undefined` for a removed document
 * — the dashboard deletes it to hand the channel back to Twitch stream-language detection — and
 * `null` for a document that holds an explicit English choice.
 *
 * @param {(change: {type: string, channelName: string, language: string|null|undefined}) => void} callback
 * @returns {Function} Unsubscribe function.
 */
export function onChannelLanguageChanges(callback) {
    const db = _getDb();
    return db.collection(LANGUAGE_COLLECTION).onSnapshot(snapshot => {
        snapshot.docChanges().forEach(change => {
            const data = change.doc.data() || {};
            const channelName = channelNameForDocKey(change.doc.id, data);
            if (!channelName) return;

            // `undefined` and `null` mean different things here, so a removed document has to
            // report undefined rather than fall through to the stored value.
            const language = change.type === 'removed' ? undefined : (data.language ?? null);

            try {
                callback({ type: change.type, channelName, language });
            } catch (err) {
                logger.error({ err, channelName }, '[LanguageStorage] Language change callback failed');
            }
        });
    }, err => {
        logger.error({ err }, '[LanguageStorage] Language listener error');
    });
}
