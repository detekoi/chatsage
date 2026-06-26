// src/lib/pronounService.js
import logger from './logger.js';

const BASE_URL = 'https://pronouns.alejo.io/api';
const VALID_USERNAME_RE = /^[a-zA-Z0-9_]{1,25}$/;

const GRAMMAR = {
    hehim:    { display: 'He/Him', subject: 'he',   Subject: 'He',   object: 'him',  Object: 'Him',  possessive: 'his',   Possessive: 'His',   reflexive: 'himself',  Reflexive: 'Himself' },
    sheher:   { display: 'She/Her', subject: 'she',  Subject: 'She',  object: 'her',  Object: 'Her',  possessive: 'her',   Possessive: 'Her',   reflexive: 'herself',  Reflexive: 'Herself' },
    theythem: { display: 'They/Them', subject: 'they', Subject: 'They', object: 'them', Object: 'Them', possessive: 'their', Possessive: 'Their', reflexive: 'themself', Reflexive: 'Themself' },
    hethem:   { display: 'He/They', subject: 'he',   Subject: 'He',   object: 'him',  Object: 'Him',  possessive: 'his',   Possessive: 'His',   reflexive: 'himself',  Reflexive: 'Himself' },
    shethem:  { display: 'She/They', subject: 'she',  Subject: 'She',  object: 'her',  Object: 'Her',  possessive: 'her',   Possessive: 'Her',   reflexive: 'herself',  Reflexive: 'Herself' },
    heshe:    { display: 'He/She', subject: 'he',   Subject: 'He',   object: 'him',  Object: 'Him',  possessive: 'his',   Possessive: 'His',   reflexive: 'himself',  Reflexive: 'Himself' },
    xexem:    { display: 'Xe/Xem', subject: 'xe',   Subject: 'Xe',   object: 'xem',  Object: 'Xem',  possessive: 'xyr',   Possessive: 'Xyr',   reflexive: 'xemself',  Reflexive: 'Xemself' },
    faefaer:  { display: 'Fae/Faer', subject: 'fae',  Subject: 'Fae',  object: 'faer', Object: 'Faer', possessive: 'faer',  Possessive: 'Faer',  reflexive: 'faerself', Reflexive: 'Faerself' },
    vever:    { display: 'Ve/Ver', subject: 've',   Subject: 'Ve',   object: 'ver',  Object: 'Ver',  possessive: 'vis',   Possessive: 'Vis',   reflexive: 'verself',  Reflexive: 'Verself' },
    aeaer:    { display: 'Ae/Aer', subject: 'ae',   Subject: 'Ae',   object: 'aer',  Object: 'Aer',  possessive: 'aer',   Possessive: 'Aer',   reflexive: 'aerself',  Reflexive: 'Aerself' },
    ziehir:   { display: 'Zie/Hir', subject: 'zie',  Subject: 'Zie',  object: 'hir',  Object: 'Hir',  possessive: 'hir',   Possessive: 'Hir',   reflexive: 'hirself',  Reflexive: 'Hirself' },
    perper:   { display: 'Per/Per', subject: 'per',  Subject: 'Per',  object: 'per',  Object: 'Per',  possessive: 'per',   Possessive: 'Per',   reflexive: 'perself',  Reflexive: 'Perself' },
    eem:      { display: 'E/Em', subject: 'e',    Subject: 'E',    object: 'em',   Object: 'Em',   possessive: 'eir',   Possessive: 'Eir',   reflexive: 'emself',   Reflexive: 'Emself' },
    itits:    { display: 'It/Its', subject: 'it',   Subject: 'It',   object: 'it',   Object: 'It',   possessive: 'its',   Possessive: 'Its',   reflexive: 'itself',   Reflexive: 'Itself' },
};

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
        this.userPronounsCache = new LRUCache(5000); // login -> { pronounId: string | null, fetchedAt: number }
        this.pendingRequests = new Map(); // login -> Promise
        this.CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
        this.NEGATIVE_CACHE_TTL_MS = 60 * 1000; // 60 seconds for errors like 429
    }

    isValidUsername(username) {
        return typeof username === 'string' && VALID_USERNAME_RE.test(username);
    }



    async _fetchUserPronounId(login) {
        if (!login) return null;
        const lowerUser = login.toLowerCase();
        if (!this.isValidUsername(lowerUser)) return null;

        const now = Date.now();
        const cached = this.userPronounsCache.get(lowerUser);
        if (cached && (now - cached.fetchedAt) < this.CACHE_TTL_MS) {
            return cached.pronounId;
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
                    const rawData = await response.json();
                    const data = Array.isArray(rawData) ? rawData[0] : rawData;

                    if (data && data.pronoun_id) {
                        this.userPronounsCache.set(lowerUser, { pronounId: data.pronoun_id, fetchedAt: Date.now() });
                        return data.pronoun_id;
                    } else {
                        this.userPronounsCache.set(lowerUser, { pronounId: null, fetchedAt: Date.now() });
                        return null;
                    }
                } else if (response.status === 404) {
                    this.userPronounsCache.set(lowerUser, { pronounId: null, fetchedAt: Date.now() });
                    return null;
                } else {
                    // Cache negative result for a short time on 429/500 errors to prevent retry storms
                    this.userPronounsCache.set(lowerUser, { pronounId: null, fetchedAt: Date.now() - this.CACHE_TTL_MS + this.NEGATIVE_CACHE_TTL_MS });
                    return null;
                }
            } catch (error) {
                logger.warn({ user: lowerUser, error: error.message }, '[PronounService] Error fetching for user');
                return null;
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
     * @returns {Promise<object|null>} Grammar object containing subject, object, etc., or null if none
     */
    async getUserPronouns(login) {
        const pronounId = await this._fetchUserPronounId(login);
        if (pronounId && GRAMMAR[pronounId]) {
            return GRAMMAR[pronounId];
        }
        return null;
    }
}

export const pronounService = new PronounService();
