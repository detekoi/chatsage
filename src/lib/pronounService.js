// src/lib/pronounService.js
import logger from './logger.js';

// Twitch Chat Pronouns v1 API (https://pr.alejo.io/). The legacy
// https://pronouns.alejo.io/api endpoint served combined IDs such as `hethem`
// and returned an array. v1 returns a single object per user and models
// mixed pronouns as `pronoun_id` plus an optional `alt_pronoun_id`.
const BASE_URL = 'https://api.pronouns.alejo.io/v1';
const VALID_USERNAME_RE = /^[a-zA-Z0-9_]{1,25}$/;

/**
 * Pronoun sets keyed by v1 pronoun ID (the keys of GET /v1/pronouns).
 * `singular` sets ("Any", "Other") display as one word rather than subject/object.
 * Grammar for singular sets falls back to they/them so callers still get usable forms.
 */
const PRONOUNS = {
    hehim:    { subject: 'he',   Subject: 'He',   object: 'him',  Object: 'Him',  possessive: 'his',   Possessive: 'His',   reflexive: 'himself',  Reflexive: 'Himself' },
    sheher:   { subject: 'she',  Subject: 'She',  object: 'her',  Object: 'Her',  possessive: 'her',   Possessive: 'Her',   reflexive: 'herself',  Reflexive: 'Herself' },
    theythem: { subject: 'they', Subject: 'They', object: 'them', Object: 'Them', possessive: 'their', Possessive: 'Their', reflexive: 'themself', Reflexive: 'Themself' },
    xexem:    { subject: 'xe',   Subject: 'Xe',   object: 'xem',  Object: 'Xem',  possessive: 'xyr',   Possessive: 'Xyr',   reflexive: 'xemself',  Reflexive: 'Xemself' },
    faefaer:  { subject: 'fae',  Subject: 'Fae',  object: 'faer', Object: 'Faer', possessive: 'faer',  Possessive: 'Faer',  reflexive: 'faerself', Reflexive: 'Faerself' },
    vever:    { subject: 've',   Subject: 'Ve',   object: 'ver',  Object: 'Ver',  possessive: 'vis',   Possessive: 'Vis',   reflexive: 'verself',  Reflexive: 'Verself' },
    aeaer:    { subject: 'ae',   Subject: 'Ae',   object: 'aer',  Object: 'Aer',  possessive: 'aer',   Possessive: 'Aer',   reflexive: 'aerself',  Reflexive: 'Aerself' },
    ziehir:   { subject: 'zie',  Subject: 'Zie',  object: 'hir',  Object: 'Hir',  possessive: 'hir',   Possessive: 'Hir',   reflexive: 'hirself',  Reflexive: 'Hirself' },
    perper:   { subject: 'per',  Subject: 'Per',  object: 'per',  Object: 'Per',  possessive: 'per',   Possessive: 'Per',   reflexive: 'perself',  Reflexive: 'Perself' },
    eem:      { subject: 'e',    Subject: 'E',    object: 'em',   Object: 'Em',   possessive: 'eir',   Possessive: 'Eir',   reflexive: 'emself',   Reflexive: 'Emself' },
    itits:    { subject: 'it',   Subject: 'It',   object: 'it',   Object: 'It',   possessive: 'its',   Possessive: 'Its',   reflexive: 'itself',   Reflexive: 'Itself' },
    any:      { singular: true, label: 'Any' },
    other:    { singular: true, label: 'Other' },
};

function lookupPronoun(id) {
    return typeof id === 'string' && Object.hasOwn(PRONOUNS, id) ? PRONOUNS[id] : null;
}

/**
 * Build the grammar object for a primary + optional alt pronoun ID, following the
 * display rules of the official extension: singular sets show their label alone,
 * mixed sets show "Primary/Alt" subjects, plain sets show "Subject/Object".
 * Grammatical forms always come from the primary set (or they/them for singular).
 * @param {string} pronounId
 * @param {string|null|undefined} altPronounId
 * @returns {object|null}
 */
export function buildGrammar(pronounId, altPronounId) {
    const primary = lookupPronoun(pronounId);
    if (!primary) return null;

    const forms = primary.singular ? PRONOUNS.theythem : primary;

    let display;
    if (primary.singular) {
        display = primary.label;
    } else {
        const alt = lookupPronoun(altPronounId);
        if (alt) {
            display = `${primary.Subject}/${alt.singular ? alt.label : alt.Subject}`;
        } else {
            display = `${primary.Subject}/${primary.Object}`;
        }
    }

    return { display, ...forms };
}

class LRUCache {
    constructor(maxSize) {
        this.cache = new Map();
        this.maxSize = maxSize;
    }

    get(key) {
        if (!this.cache.has(key)) return undefined;
        const val = this.cache.get(key);
        // refresh
        this.cache.delete(key);
        this.cache.set(key, val);
        return val;
    }

    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            // Evict oldest (first item in Map iteration)
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }
}

class PronounService {
    constructor() {
        // login -> { pronounId: string | null, altPronounId: string | null, fetchedAt: number }
        this.userPronounsCache = new LRUCache(5000);
        this.pendingRequests = new Map(); // login -> Promise
        this.CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
        this.NEGATIVE_CACHE_TTL_MS = 60 * 1000; // 60 seconds for errors like 429
    }

    isValidUsername(username) {
        return typeof username === 'string' && VALID_USERNAME_RE.test(username);
    }

    _cacheEntry(login, pronounId, altPronounId, fetchedAt = Date.now()) {
        const entry = { pronounId: pronounId || null, altPronounId: altPronounId || null, fetchedAt };
        this.userPronounsCache.set(login, entry);
        return entry;
    }

    /**
     * Resolve a user's pronoun IDs from the v1 API, with caching and request dedup.
     * @param {string} login Twitch username
     * @returns {Promise<{pronounId: string|null, altPronounId: string|null}>}
     */
    async _fetchUserPronounIds(login) {
        const none = { pronounId: null, altPronounId: null };
        if (!login) return none;
        const lowerUser = login.toLowerCase();
        if (!this.isValidUsername(lowerUser)) return none;

        const now = Date.now();
        const cached = this.userPronounsCache.get(lowerUser);
        if (cached && (now - cached.fetchedAt) < this.CACHE_TTL_MS) {
            return cached;
        }

        if (this.pendingRequests.has(lowerUser)) {
            return this.pendingRequests.get(lowerUser);
        }

        const fetchPromise = (async () => {
            let timeoutId;
            try {
                const controller = new AbortController();
                timeoutId = setTimeout(() => controller.abort(), 3000);
                const response = await fetch(`${BASE_URL}/users/${encodeURIComponent(lowerUser)}`, { signal: controller.signal });

                if (response.ok) {
                    const data = await response.json();
                    if (data && typeof data.pronoun_id === 'string' && data.pronoun_id) {
                        return this._cacheEntry(lowerUser, data.pronoun_id, data.alt_pronoun_id);
                    }
                    return this._cacheEntry(lowerUser, null, null);
                } else if (response.status === 404) {
                    // v1 returns 404 when the user has not set pronouns.
                    return this._cacheEntry(lowerUser, null, null);
                } else {
                    // Cache negative result for a short time on 429/500 errors to prevent retry storms
                    return this._cacheEntry(lowerUser, null, null, Date.now() - this.CACHE_TTL_MS + this.NEGATIVE_CACHE_TTL_MS);
                }
            } catch (error) {
                logger.warn({ user: lowerUser, error: error.message }, '[PronounService] Error fetching for user');
                return none;
            } finally {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
                this.pendingRequests.delete(lowerUser);
            }
        })();

        this.pendingRequests.set(lowerUser, fetchPromise);
        return fetchPromise;
    }

    /**
     * Get the grammatical forms for a user's pronouns.
     * @param {string} login Twitch username
     * @returns {Promise<object|null>} Grammar object containing display, subject, object, etc., or null if none
     */
    async getUserPronouns(login) {
        const { pronounId, altPronounId } = await this._fetchUserPronounIds(login);
        return buildGrammar(pronounId, altPronounId);
    }
}

export const pronounService = new PronounService();
