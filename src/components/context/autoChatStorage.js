import { Firestore } from '@google-cloud/firestore';
import logger from '../../lib/logger.js';

// Firestore collection for per-channel auto-chat configs
const AUTO_CHAT_COLLECTION = 'autoChatConfigs';

let db = null; // Firestore instance

export async function initializeAutoChatStorage() {
    logger.info('[AutoChatStorage] Initializing Firestore client...');
    try {
        db = new Firestore();
        // Smoke test
        await db.collection(AUTO_CHAT_COLLECTION).limit(1).get();
        logger.info('[AutoChatStorage] Firestore client initialized.');
    } catch (err) {
        logger.error({ err }, '[AutoChatStorage] Failed to initialize Firestore');
        throw err;
    }
}

function _getDb() {
    if (!db) {
        throw new Error('[AutoChatStorage] Storage not initialized. Call initializeAutoChatStorage first.');
    }
    return db;
}

// Default config when none stored
export const DEFAULT_AUTO_CHAT_CONFIG = Object.freeze({
    mode: 'off', // 'off' | 'low' | 'medium' | 'high'
    categories: {
        greetings: true,
        facts: true,
        questions: true,
        celebrations: true,
        ads: false,
    },
});

export async function getChannelAutoChatConfig(channelName) {
    const db = _getDb();
    const docRef = db.collection(AUTO_CHAT_COLLECTION).doc(channelName.toLowerCase());
    try {
        const snap = await docRef.get();
        if (!snap.exists) return { ...DEFAULT_AUTO_CHAT_CONFIG };
        const data = snap.data() || {};
        return normalizeConfig(data);
    } catch (err) {
        logger.error({ err, channelName }, '[AutoChatStorage] Error loading auto-chat config');
        return { ...DEFAULT_AUTO_CHAT_CONFIG };
    }
}

export async function saveChannelAutoChatConfig(channelName, config) {
    const db = _getDb();
    const clean = normalizeConfig(config);
    try {
        await db.collection(AUTO_CHAT_COLLECTION).doc(channelName.toLowerCase()).set({
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
            const name = (data.channelName || doc.id || '').toLowerCase();
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
    const categories = {
        greetings: cfg.categories?.greetings !== false,
        facts: cfg.categories?.facts !== false,
        questions: cfg.categories?.questions !== false,
        celebrations: cfg.categories?.celebrations !== false,
        ads: cfg.categories?.ads === true, // opt-in only
    };
    return { mode, categories };
}

// Listener for real-time config changes (used to react to ads toggle)
export function onAutoChatConfigChanges(callback) {
    const db = _getDb();
    const col = db.collection(AUTO_CHAT_COLLECTION);
    return col.onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
            const raw = change.doc.data() || {};
            const cfg = normalizeConfig(raw);
            const channelName = (raw.channelName || change.doc.id || '').toLowerCase();
            if (!channelName) return;
            try { callback({ type: change.type, channelName, config: cfg }); } catch (_) {}
        });
    });
}


