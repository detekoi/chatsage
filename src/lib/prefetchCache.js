// src/lib/prefetchCache.js
import logger from './logger.js';

export class PrefetchCache {
    constructor() {
        this.cache = new Map(); // key -> { value, createdAtMs, ttlMs, timerId }
        this.inFlight = new Map(); // key -> Promise
    }

    /**
     * Stores a value in the cache manually with active TTL eviction.
     * @param {string} key
     * @param {*} value
     * @param {number} [ttlMs=300000] - Default TTL 5 minutes
     */
    set(key, value, ttlMs = 5 * 60 * 1000) {
        if (value === null || value === undefined) {
            this.clear(key);
            return;
        }

        // Clear existing active eviction timer if present
        const existing = this.cache.get(key);
        if (existing?.timerId) {
            clearTimeout(existing.timerId);
        }

        let timerId = null;
        if (ttlMs) {
            timerId = setTimeout(() => {
                const current = this.cache.get(key);
                if (current && current.timerId === timerId) {
                    this.cache.delete(key);
                    logger.debug({ key }, '[PrefetchCache] Evicted expired item');
                }
            }, ttlMs);
            if (timerId.unref) {
                timerId.unref();
            }
        }

        this.cache.set(key, {
            value,
            createdAtMs: Date.now(),
            ttlMs,
            timerId,
        });
    }

    /**
     * Retrieves and consumes (deletes) a cached value if present and not expired.
     * @param {string} key
     * @returns {*|null}
     */
    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;

        if (item.timerId) {
            clearTimeout(item.timerId);
        }
        this.cache.delete(key);

        if (item.ttlMs && Date.now() - item.createdAtMs > item.ttlMs) {
            logger.debug({ key }, '[PrefetchCache] Cached item expired');
            return null;
        }

        return item.value;
    }

    /**
     * Checks if a key has a cached value or an in-flight prefetch operation.
     * @param {string} key
     * @returns {boolean}
     */
    has(key) {
        return this.cache.has(key) || this.inFlight.has(key);
    }

    /**
     * Triggers a background prefetch using fetcherFn.
     * Stores the in-flight promise and saves the result upon completion.
     * Discards late completions if the in-flight operation was cleared or timed out.
     * @param {string} key
     * @param {Function} fetcherFn - Async function returning a result
     * @param {number} [ttlMs=300000]
     * @returns {Promise<*>}
     */
    prefetch(key, fetcherFn, ttlMs = 5 * 60 * 1000) {
        if (this.inFlight.has(key)) {
            logger.debug({ key }, '[PrefetchCache] Prefetch already in-flight for key');
            return this.inFlight.get(key);
        }

        logger.debug({ key }, '[PrefetchCache] 🔄 Starting prefetch...');
        const promise = (async () => {
            try {
                const result = await fetcherFn();
                // Only set cache if this promise is still the active in-flight request
                if (this.inFlight.get(key) === promise) {
                    if (result !== null && result !== undefined && (typeof result !== 'string' || result.trim())) {
                        this.set(key, result, ttlMs);
                        logger.debug({ key }, '[PrefetchCache] ✓ Prefetch completed and cached');
                    } else {
                        logger.warn({ key }, '[PrefetchCache] Prefetch returned empty/null result');
                    }
                } else {
                    logger.warn({ key }, '[PrefetchCache] Prefetch completed after cancellation/timeout — discarding stale result');
                }
                return result;
            } catch (err) {
                logger.warn({ err, key }, '[PrefetchCache] Prefetch execution failed');
                return null;
            } finally {
                if (this.inFlight.get(key) === promise) {
                    this.inFlight.delete(key);
                }
            }
        })();

        this.inFlight.set(key, promise);
        return promise;
    }

    /**
     * Consumes a prefetched result if available, awaits an in-flight prefetch
     * with a timeout, or executes fallbackFetcherFn on demand.
     * Cancels in-flight status on timeout to prevent stale cache poisoning.
     * @param {string} key
     * @param {Function} fallbackFetcherFn - Async function executed if prefetch fails or is missing
     * @param {number} [timeoutMs=10000] - Max ms to await in-flight prefetch
     * @returns {Promise<*>}
     */
    async getOrAwait(key, fallbackFetcherFn, timeoutMs = 10000) {
        // 1. Immediate hit from completed prefetch cache
        const cached = this.get(key);
        if (cached !== null && cached !== undefined) {
            logger.info({ key }, '[PrefetchCache] ✓ Used pre-cached response');
            return cached;
        }

        // 2. Await in-flight prefetch if currently running
        if (this.inFlight.has(key)) {
            logger.info({ key, timeoutMs }, '[PrefetchCache] Awaiting in-flight prefetch...');
            const promise = this.inFlight.get(key);
            let timeoutId;
            const timeoutPromise = new Promise((resolve) => {
                timeoutId = setTimeout(() => {
                    logger.warn({ key, timeoutMs }, '[PrefetchCache] Timed out waiting for in-flight prefetch');
                    // Remove key from inFlight so late resolution will be discarded
                    if (this.inFlight.get(key) === promise) {
                        this.inFlight.delete(key);
                    }
                    resolve(null);
                }, timeoutMs);
            });

            try {
                const result = await Promise.race([promise, timeoutPromise]);
                clearTimeout(timeoutId);
                // Check if prefetch populated cache during the race
                const consumed = this.get(key) || result;
                if (consumed !== null && consumed !== undefined && (typeof consumed !== 'string' || consumed.trim())) {
                    logger.info({ key }, '[PrefetchCache] ✓ Successfully awaited in-flight prefetch');
                    return consumed;
                }
            } catch (err) {
                clearTimeout(timeoutId);
                logger.warn({ err, key }, '[PrefetchCache] In-flight prefetch error during await');
            }
        }

        // 3. Fallback to live on-demand generation
        logger.info({ key }, '[PrefetchCache] No valid prefetch found, executing live fallback');
        return await fallbackFetcherFn();
    }

    /**
     * Clears specific key from cache and in-flight map.
     * @param {string} key
     */
    clear(key) {
        const item = this.cache.get(key);
        if (item?.timerId) {
            clearTimeout(item.timerId);
        }
        this.cache.delete(key);
        this.inFlight.delete(key);
    }

    /**
     * Clears all keys matching a prefix.
     * @param {string} prefix
     */
    clearPrefix(prefix) {
        for (const [key, item] of this.cache.entries()) {
            if (key.startsWith(prefix)) {
                if (item?.timerId) clearTimeout(item.timerId);
                this.cache.delete(key);
            }
        }
        for (const key of this.inFlight.keys()) {
            if (key.startsWith(prefix)) this.inFlight.delete(key);
        }
    }

    /**
     * Clears all entries and in-flight promises.
     */
    clearAll() {
        for (const item of this.cache.values()) {
            if (item?.timerId) clearTimeout(item.timerId);
        }
        this.cache.clear();
        this.inFlight.clear();
    }
}

// Global default instance for convenience
export const defaultPrefetchCache = new PrefetchCache();
