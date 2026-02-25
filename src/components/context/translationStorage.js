// src/components/context/translationStorage.js
import { Firestore } from '@google-cloud/firestore';
import logger from '../../lib/logger.js';

// Reuse a single Firestore instance (SDK reuses gRPC channels internally)
let db = null;

// Collection name for user translation preferences
const TRANSLATION_COLLECTION = 'userTranslations';

/**
 * Gets or creates the Firestore database instance.
 * @returns {Firestore}
 */
function _getDb() {
    if (!db) {
        db = new Firestore();
    }
    return db;
}

/**
 * Generates a consistent document ID for a user's translation state.
 * @param {string} channelName - Channel name (without '#').
 * @param {string} username - Username (lowercase).
 * @returns {string} Document ID in format "channelName:username".
 */
function _getDocId(channelName, username) {
    return `${channelName.toLowerCase()}:${username.toLowerCase()}`;
}

/**
 * Saves a user's translation preference to Firestore.
 * @param {string} channelName - Channel name (without '#').
 * @param {string} username - Username (lowercase).
 * @param {string} language - Target language for translation.
 * @returns {Promise<boolean>} True on success, false on failure.
 */
export async function saveUserTranslation(channelName, username, language) {
    try {
        const firestore = _getDb();
        const docId = _getDocId(channelName, username);
        await firestore.collection(TRANSLATION_COLLECTION).doc(docId).set({
            channelName: channelName.toLowerCase(),
            username: username.toLowerCase(),
            targetLanguage: language,
            updatedAt: new Date()
        }, { merge: true });
        logger.debug(`[TranslationStorage] Saved translation for ${username} in ${channelName}: ${language}`);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: username }, '[TranslationStorage] Error saving user translation');
        return false;
    }
}

/**
 * Removes a user's translation preference from Firestore.
 * @param {string} channelName - Channel name (without '#').
 * @param {string} username - Username (lowercase).
 * @returns {Promise<boolean>} True on success, false on failure.
 */
export async function removeUserTranslation(channelName, username) {
    try {
        const firestore = _getDb();
        const docId = _getDocId(channelName, username);
        await firestore.collection(TRANSLATION_COLLECTION).doc(docId).delete();
        logger.debug(`[TranslationStorage] Removed translation for ${username} in ${channelName}`);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: username }, '[TranslationStorage] Error removing user translation');
        return false;
    }
}

/**
 * Loads all active user translation preferences from Firestore.
 * @returns {Promise<Array<{channelName: string, username: string, targetLanguage: string}>>}
 */
export async function loadAllUserTranslations() {
    try {
        const firestore = _getDb();
        const snapshot = await firestore.collection(TRANSLATION_COLLECTION).get();
        const translations = [];

        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.channelName && data.username && data.targetLanguage) {
                translations.push({
                    channelName: data.channelName,
                    username: data.username,
                    targetLanguage: data.targetLanguage
                });
            }
        });

        logger.info(`[TranslationStorage] Loaded ${translations.length} active user translation(s)`);
        return translations;
    } catch (error) {
        logger.error({ err: error }, '[TranslationStorage] Error loading user translations');
        return [];
    }
}
