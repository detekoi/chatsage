// src/lib/userIdentity.js
//
// Login <-> Twitch user ID resolution for chatters.
//
// Chatter-scoped data (memories, opt-outs, game stats, translation settings) is identified by the
// immutable Twitch user ID, never by login: a login changes on rename and can later be claimed by
// someone else. Every chat message carries both, so the pairs are learned for free as chat flows;
// a login typed into chat ("!hug @bob") is resolved from what was seen, then from Helix.
import logger from './logger.js';
import { getUsersByLogin } from '../components/twitch/helixClient.js';

const MAX_ENTRIES = 10000;
const HELIX_BATCH_SIZE = 100;
// Pairs seen in chat are refreshed on every message; ones fetched from Helix age out so a
// released-and-reclaimed login can't stay pinned to its previous owner.
const HELIX_RESULT_TTL_MS = 60 * 60 * 1000;
const LOGIN_PATTERN = /^[a-z0-9_]{2,25}$/;

/** @type {Map<string, {id: string, expiresAt: number}>} login -> id, insertion order = LRU order */
const idsByLogin = new Map();
/** @type {Map<string, string>} id -> login */
const loginsById = new Map();

/**
 * Normalizes a login as typed in chat: trims, drops a leading '@', lowercases.
 * @param {string} raw
 * @returns {string|null} The login, or null when it isn't login-shaped.
 */
export function normalizeLogin(raw) {
    if (typeof raw !== 'string') return null;
    const login = raw.trim().replace(/^@/, '').toLowerCase();
    return LOGIN_PATTERN.test(login) ? login : null;
}

function _touch(map, key, value) {
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
}

function _remember(userId, login, ttlMs) {
    const previousLogin = loginsById.get(userId);
    if (previousLogin && previousLogin !== login && idsByLogin.get(previousLogin)?.id === userId) {
        idsByLogin.delete(previousLogin);
    }
    _touch(idsByLogin, login, { id: userId, expiresAt: Date.now() + ttlMs });
    _touch(loginsById, userId, login);
}

/**
 * Records a login/ID pair seen on a chat message or EventSub event.
 * @param {string} userId
 * @param {string} login
 */
export function noteUser(userId, login) {
    const id = userId ? String(userId) : '';
    const normalized = normalizeLogin(login);
    if (!/^\d+$/.test(id) || !normalized) return;
    _remember(id, normalized, Infinity);
}

/**
 * The login a user ID was last seen with, from cache only.
 * @param {string} userId
 * @returns {string|null}
 */
export function currentLogin(userId) {
    return loginsById.get(String(userId)) || null;
}

/**
 * The user ID a login was last seen with, from cache only.
 * @param {string} login
 * @returns {string|null}
 */
export function cachedUserId(login) {
    const entry = idsByLogin.get(normalizeLogin(login));
    return entry && entry.expiresAt > Date.now() ? entry.id : null;
}

/**
 * Resolves logins (as typed: '@Bob', 'bob') to user IDs. Words that aren't login-shaped are
 * ignored. Never throws; a login Twitch doesn't know is simply absent from the result.
 * @param {string[]} logins
 * @returns {Promise<Map<string, string>>} normalized login -> user ID
 */
export async function resolveUserIds(logins) {
    const resolved = new Map();
    const misses = [];
    const now = Date.now();
    for (const raw of logins || []) {
        const login = normalizeLogin(raw);
        if (!login || resolved.has(login) || misses.includes(login)) continue;
        const cached = idsByLogin.get(login);
        if (cached && cached.expiresAt > now) resolved.set(login, cached.id);
        else misses.push(login);
    }

    for (let i = 0; i < misses.length; i += HELIX_BATCH_SIZE) {
        const batch = misses.slice(i, i + HELIX_BATCH_SIZE);
        try {
            const users = await getUsersByLogin(batch, 'User ID resolution');
            for (const user of users || []) {
                const login = normalizeLogin(user?.login);
                if (!login || !user.id) continue;
                _remember(String(user.id), login, HELIX_RESULT_TTL_MS);
                resolved.set(login, String(user.id));
            }
        } catch (error) {
            logger.warn({ err: error, count: batch.length }, '[UserIdentity] Login lookup failed');
        }
    }
    return resolved;
}

/** Test seam. */
export function _clearUserIdentityCache() {
    idsByLogin.clear();
    loginsById.clear();
}
