// Layout: autoChatConfigs/{broadcasterId} -> { channelName, mode, categories }
// Keyed by broadcaster ID, not login (see lib/channelKey.js). The web UI writes
// the same documents (chatsage-web-ui/functions/src/api/autoChat.router.ts).
import { getFirestore } from '../../lib/firestore.js';
import { channelDocKey, channelNameForDocKey } from '../../lib/channelKey.js';
import logger from '../../lib/logger.js';

// Firestore collection for per-channel auto-chat configs
const AUTO_CHAT_COLLECTION = 'autoChatConfigs';

/**
 * No-op – Firestore is now initialized centrally via initializeFirestore() in initComponents.js.
 */
export async function initializeAutoChatStorage() {
    logger.debug('[AutoChatStorage] Using shared Firestore client.');
}

/** @returns {import('@google-cloud/firestore').Firestore} */
function _getDb() {
    return getFirestore();
}

// Default config when none stored
export const DEFAULT_AUTO_CHAT_CONFIG = Object.freeze({
    mode: 'off', // 'off' | 'low' | 'medium' | 'high'
    categories: {
        greetings: true,
        facts: true,
        questions: true,
        follows: true,
        subscriptions: true,
        raids: true,
        ads: false,
    },
});

function _channelDocRef(channelName) {
    return _getDb().collection(AUTO_CHAT_COLLECTION).doc(channelDocKey(channelName));
}

export async function getChannelAutoChatConfig(channelName) {
    try {
        const snap = await _channelDocRef(channelName).get();
        if (!snap.exists) return { ...DEFAULT_AUTO_CHAT_CONFIG };
        const data = snap.data() || {};
        return normalizeConfig(data);
    } catch (err) {
        logger.error({ err, channelName }, '[AutoChatStorage] Error loading auto-chat config');
        return { ...DEFAULT_AUTO_CHAT_CONFIG };
    }
}

export async function saveChannelAutoChatConfig(channelName, config) {
    const clean = normalizeConfig(config);
    try {
        await _channelDocRef(channelName).set({
            channelName: channelName.toLowerCase(),
            ...clean,
            updatedAt: new Date(),
        }, { merge: true });
        logger.info({ channelName, config: clean }, '[AutoChatStorage] Saved auto-chat config');
        return true;
    } catch (err) {
        logger.error({ err, channelName }, '[AutoChatStorage] Error saving auto-chat config');
        return false;
    }
}

export async function loadAllAutoChatConfigs() {
    const db = _getDb();
    const map = new Map();
    try {
        const snapshot = await db.collection(AUTO_CHAT_COLLECTION).get();
        snapshot.forEach(doc => {
            const data = doc.data() || {};
            const cfg = normalizeConfig(data);
            const name = channelNameForDocKey(doc.id, data);
            if (name) map.set(name, cfg);
        });
        logger.info(`[AutoChatStorage] Loaded ${map.size} auto-chat configs`);
        return map;
    } catch (err) {
        logger.error({ err }, '[AutoChatStorage] Error loading all auto-chat configs');
        return map;
    }
}

export function normalizeConfig(input) {
    const cfg = input && typeof input === 'object' ? input : {};
    const mode = ['off', 'low', 'medium', 'high'].includes((cfg.mode || '').toLowerCase())
        ? cfg.mode.toLowerCase()
        : 'off';
    // Backward compat: if legacy 'celebrations' key exists, new keys inherit its value
    const legacyCelebrations = cfg.categories?.celebrations;
    const celebDefault = legacyCelebrations !== undefined ? legacyCelebrations !== false : true;
    const categories = {
        greetings: cfg.categories?.greetings !== false,
        facts: cfg.categories?.facts !== false,
        questions: cfg.categories?.questions !== false,
        follows: cfg.categories?.follows !== undefined ? cfg.categories.follows !== false : celebDefault,
        subscriptions: cfg.categories?.subscriptions !== undefined ? cfg.categories.subscriptions !== false : celebDefault,
        raids: cfg.categories?.raids !== undefined ? cfg.categories.raids !== false : celebDefault,
        ads: cfg.categories?.ads === true, // opt-in only
    };
    return { mode, categories };
}


