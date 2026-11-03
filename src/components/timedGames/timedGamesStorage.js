// src/components/timedGames/timedGamesStorage.js
// Firestore persistence for timed games: chat games the bot starts on its own
// at a fixed interval while the stream is live.
//
// Layout: timedGameConfigs/{broadcasterId} ->
//   { channelName, enabled, intervalMinutes, games, updatedAt,   // settings
//     lastRunAt, lastGame }                                       // bot-owned runtime state
// Keyed by broadcaster ID, not login (see lib/channelKey.js).
//
// The settings contract is duplicated in the web UI repo:
//   chatsage-web-ui/functions/src/api/timedGames.router.ts (limits in config/constants.ts)
// Keep field names, defaults, and limits in sync between the two. The web UI
// never writes lastRunAt or lastGame.

import { getFirestore, FieldValue } from '../../lib/firestore.js';
import { channelDocKey, channelNameForDocKey } from '../../lib/channelKey.js';
import logger from '../../lib/logger.js';

const TIMED_GAMES_COLLECTION = 'timedGameConfigs';

// ─── Shared limits (mirrored in the web UI) ─────────────────────────────────
// Canonical rotation order. A channel's pool is always stored in this order.
export const TIMED_GAME_IDS = Object.freeze(['trivia', 'geo', 'riddle']);
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 720;
export const DEFAULT_INTERVAL_MINUTES = 30;

export const DEFAULT_TIMED_GAMES_CONFIG = Object.freeze({
    enabled: false,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    games: TIMED_GAME_IDS,
});

// How early, relative to the interval, a claim still counts as due. Same
// reasoning as timersStorage.CLAIM_SLACK_MS: lastRunAt is a server timestamp
// taken slightly after the local fire time, and ticks run once a minute.
export const CLAIM_SLACK_MS = 60 * 1000;

function _getDb() {
    return getFirestore();
}

function _docRef(channelName) {
    return _getDb().collection(TIMED_GAMES_COLLECTION).doc(channelDocKey(channelName));
}

/**
 * Parses a game list from an array or a comma/space separated string.
 * Unknown names are dropped; the result is de-duplicated and in canonical order.
 * @param {string[]|string} input
 * @returns {string[]}
 */
export function parseGameList(input) {
    const raw = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/);
    const wanted = new Set(raw.map(g => String(g || '').trim().toLowerCase()).filter(Boolean));
    return TIMED_GAME_IDS.filter(id => wanted.has(id));
}

/**
 * Normalizes a stored or user-supplied config. Settings only: runtime fields
 * (lastRunAt, lastGame) are read separately by the manager.
 * @param {object} input
 * @returns {{enabled: boolean, intervalMinutes: number, games: string[]}}
 */
export function normalizeConfig(input) {
    const cfg = input && typeof input === 'object' ? input : {};
    const interval = Number(cfg.intervalMinutes);
    const intervalMinutes = Number.isInteger(interval)
        && interval >= MIN_INTERVAL_MINUTES
        && interval <= MAX_INTERVAL_MINUTES
        ? interval
        : DEFAULT_INTERVAL_MINUTES;
    const games = cfg.games === undefined ? [...TIMED_GAME_IDS] : parseGameList(cfg.games);
    return {
        enabled: cfg.enabled === true,
        intervalMinutes,
        games: games.length > 0 ? games : [...TIMED_GAME_IDS],
    };
}

/**
 * Reads a doc into a config plus the bot's runtime state.
 * @param {object} data - Raw document data.
 */
export function fromDoc(data) {
    const d = data || {};
    const lastRunAtMs = typeof d.lastRunAt?.toMillis === 'function' ? d.lastRunAt.toMillis() : 0;
    const lastGame = TIMED_GAME_IDS.includes(d.lastGame) ? d.lastGame : null;
    return { ...normalizeConfig(d), lastRunAtMs, lastGame };
}

/**
 * @param {string} channelName
 * @returns {Promise<ReturnType<typeof fromDoc>>} The channel's config (defaults when none is stored).
 */
export async function getTimedGamesConfig(channelName) {
    try {
        const snap = await _docRef(channelName).get();
        return fromDoc(snap.exists ? snap.data() : null);
    } catch (err) {
        logger.error({ err, channelName }, '[TimedGamesStorage] Error loading timed games config');
        return fromDoc(null);
    }
}

/**
 * Merges settings into a channel's config. Only enabled, intervalMinutes and
 * games are written; other keys in `partial` are ignored.
 * @param {string} channelName
 * @param {object} partial
 * @returns {Promise<boolean>} True on success.
 */
export async function saveTimedGamesConfig(channelName, partial) {
    const update = {};
    if (partial.enabled !== undefined) update.enabled = partial.enabled === true;
    if (partial.intervalMinutes !== undefined) update.intervalMinutes = partial.intervalMinutes;
    if (partial.games !== undefined) update.games = parseGameList(partial.games);
    try {
        await _docRef(channelName).set({
            channelName: String(channelName).toLowerCase(),
            ...update,
            updatedAt: new Date(),
        }, { merge: true });
        logger.info({ channelName, update }, '[TimedGamesStorage] Saved timed games config');
        return true;
    } catch (err) {
        logger.error({ err, channelName }, '[TimedGamesStorage] Error saving timed games config');
        return false;
    }
}

/**
 * @returns {Promise<Map<string, ReturnType<typeof fromDoc>>>} channelName -> config.
 */
export async function loadAllTimedGamesConfigs() {
    const map = new Map();
    try {
        const snapshot = await _getDb().collection(TIMED_GAMES_COLLECTION).get();
        snapshot.forEach(doc => {
            const data = doc.data() || {};
            const name = channelNameForDocKey(doc.id, data);
            if (name) map.set(name, fromDoc(data));
        });
        logger.info(`[TimedGamesStorage] Loaded ${map.size} timed games configs`);
    } catch (err) {
        logger.error({ err }, '[TimedGamesStorage] Error loading all timed games configs');
    }
    return map;
}

/**
 * Listens for config changes so command and dashboard edits apply without a restart.
 * @param {Function} onChange - Called per change with ({ type, channelName, config }).
 *   `config` is null for a removed doc.
 * @returns {Function} Unsubscribe.
 */
export function listenForTimedGamesChanges(onChange) {
    logger.info('[TimedGamesStorage] Setting up listener for timed games config changes...');
    return _getDb().collection(TIMED_GAMES_COLLECTION).onSnapshot(snapshot => {
        snapshot.docChanges().forEach(change => {
            const data = change.doc.data() || {};
            const channelName = channelNameForDocKey(change.doc.id, data);
            if (!channelName) {
                logger.debug({ docId: change.doc.id }, '[TimedGamesStorage] Change for an unknown channel. Skipping.');
                return;
            }
            onChange({
                type: change.type,
                channelName,
                config: change.type === 'removed' ? null : fromDoc(data),
            });
        });
    }, error => {
        logger.error({ err: error }, '[TimedGamesStorage] Error in timed games config listener.');
    });
}

/**
 * Atomically claims one timed game run before the game starts, and records
 * which game it is. A second claim inside the interval is refused, which keeps
 * two instances from starting a game for the same run while a channel changes
 * hands. Throws on Firestore errors so the caller decides whether to fail open.
 * @param {string} channelName
 * @param {number} intervalMs
 * @param {string} game - The game this run starts.
 * @returns {Promise<{claimed: boolean, lastRunAtMs: number, lastGame: string|null}>}
 *   On refusal, lastRunAtMs and lastGame describe the run that got there first.
 */
export async function claimTimedGameRun(channelName, intervalMs, game) {
    const db = _getDb();
    const docRef = _docRef(channelName);
    return db.runTransaction(async (t) => {
        const snap = await t.get(docRef);
        const { lastRunAtMs, lastGame } = fromDoc(snap.exists ? snap.data() : null);
        const nowMs = Date.now();
        if (lastRunAtMs && nowMs - lastRunAtMs < intervalMs - CLAIM_SLACK_MS) {
            return { claimed: false, lastRunAtMs, lastGame };
        }
        t.set(docRef, { lastRunAt: FieldValue.serverTimestamp(), lastGame: game }, { merge: true });
        return { claimed: true, lastRunAtMs: nowMs, lastGame: game };
    });
}

/**
 * Records a run when the claim could not be made (Firestore error) but the
 * game started anyway, so the next owner does not see the run as overdue.
 * Fire-and-forget: errors are logged, never thrown.
 */
export async function recordTimedGameRun(channelName, game) {
    try {
        await _docRef(channelName).set({ lastRunAt: FieldValue.serverTimestamp(), lastGame: game }, { merge: true });
    } catch (err) {
        logger.warn({ err, channelName }, '[TimedGamesStorage] Error recording timed game run');
    }
}
