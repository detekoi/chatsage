// src/components/context/translationStorage.js
import { getFirestore } from '../../lib/firestore.js';
import logger from '../../lib/logger.js';
import { channelDocKey, channelNameForDocKey, normalizeChannelName } from '../../lib/channelKey.js';

// Collection name for user translation preferences
const TRANSLATION_COLLECTION = 'userTranslations';

// Documents are keyed "<broadcasterId>:<userId>". Anything else is a legacy login-keyed document
// ("<channelLogin>:<userLogin>") left for scripts/migrate-channel-keys.js to move.
const DOC_ID_PATTERN = /^(\d+):(\d+)$/;

/** @returns {import('@google-cloud/firestore').Firestore} */
function _getDb() {
    return getFirestore();
}

/**
 * The document ID for a user's translation state: both halves are immutable Twitch user IDs,
 * so a rename of the channel or the viewer never orphans the setting.
 * @param {string} channelName - Channel login (without '#').
 * @param {string} userId - The viewer's Twitch user ID.
 * @returns {string} Document ID in format "broadcasterId:userId".
 * @throws {import('../../lib/channelKey.js').UnresolvedChannelError} When the channel has no known broadcaster ID.
 */
function _getDocId(channelName, userId) {
    const id = userId ? String(userId) : '';
    if (!/^\d+$/.test(id)) {
        throw new Error(`Invalid Twitch user ID "${userId}" for translation setting`);
    }
    return `${channelDocKey(channelName)}:${id}`;
}

/**
 * Saves a user's translation preference to Firestore.
 * @param {string} channelName - Channel login (without '#').
 * @param {string} userId - The viewer's Twitch user ID.
 * @param {string|null} login - The viewer's current login, stored for readability only.
 * @param {string} language - Target language for translation.
 * @returns {Promise<boolean>} True on success, false on failure.
 */
export async function saveUserTranslation(channelName, userId, login, language) {
    try {
        const firestore = _getDb();
        const docId = _getDocId(channelName, userId);
        await firestore.collection(TRANSLATION_COLLECTION).doc(docId).set({
            channelName: normalizeChannelName(channelName),
            userId: String(userId),
            login: login ? String(login).toLowerCase() : null,
            targetLanguage: language,
            updatedAt: new Date()
        }, { merge: true });
        logger.debug(`[TranslationStorage] Saved translation for ${login || userId} in ${channelName}: ${language}`);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, userId, user: login }, '[TranslationStorage] Error saving user translation');
        return false;
    }
}

/**
 * Removes a user's translation preference from Firestore.
 * @param {string} channelName - Channel login (without '#').
 * @param {string} userId - The viewer's Twitch user ID.
 * @returns {Promise<boolean>} True on success, false on failure.
 */
export async function removeUserTranslation(channelName, userId) {
    try {
        const firestore = _getDb();
        const docId = _getDocId(channelName, userId);
        await firestore.collection(TRANSLATION_COLLECTION).doc(docId).delete();
        logger.debug(`[TranslationStorage] Removed translation for user ${userId} in ${channelName}`);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, userId }, '[TranslationStorage] Error removing user translation');
        return false;
    }
}

/**
 * Loads all active user translation preferences from Firestore.
 * Legacy login-keyed documents are skipped; the migration script moves them.
 * @returns {Promise<Array<{channelName: string, userId: string, login: string|null, targetLanguage: string}>>}
 */
export async function loadAllUserTranslations() {
    try {
        const firestore = _getDb();
        const snapshot = await firestore.collection(TRANSLATION_COLLECTION).get();
        const translations = [];
        let legacyCount = 0;

        snapshot.forEach(doc => {
            const match = DOC_ID_PATTERN.exec(doc.id);
            if (!match) {
                legacyCount++;
                logger.debug({ docId: doc.id }, '[TranslationStorage] Skipping legacy login-keyed translation document');
                return;
            }
            const [, broadcasterId, userId] = match;
            const data = doc.data() || {};
            const channelName = channelNameForDocKey(broadcasterId, data);
            if (!channelName || !data.targetLanguage) return;
            translations.push({
                channelName,
                userId,
                login: typeof data.login === 'string' ? data.login : null,
                targetLanguage: data.targetLanguage
            });
        });

        if (legacyCount > 0) {
            logger.debug(`[TranslationStorage] Skipped ${legacyCount} legacy translation document(s) awaiting migration`);
        }
        logger.info(`[TranslationStorage] Loaded ${translations.length} active user translation(s)`);
        return translations;
    } catch (error) {
        logger.error({ err: error }, '[TranslationStorage] Error loading user translations');
        return [];
    }
}
