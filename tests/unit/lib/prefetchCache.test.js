// tests/unit/lib/prefetchCache.test.js
import { PrefetchCache } from '../../../src/lib/prefetchCache.js';

jest.mock('../../../src/lib/logger.js', () => ({
    __esModule: true,
    default: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

describe('PrefetchCache', () => {
    let cache;

    beforeEach(() => {
        cache = new PrefetchCache();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('stores and consumes (get) value atomically', () => {
        cache.set('test:key', 'hello world');
        expect(cache.has('test:key')).toBe(true);

        const val = cache.get('test:key');
        expect(val).toBe('hello world');
        expect(cache.has('test:key')).toBe(false);
    });

    test('returns null and purges expired item', () => {
        cache.set('test:key', 'hello world', 1000);
        jest.advanceTimersByTime(1500);

        expect(cache.get('test:key')).toBeNull();
        expect(cache.has('test:key')).toBe(false);
    });

    test('prefetches in background and stores result', async () => {
        const fetcher = jest.fn().mockResolvedValue('prefetched result');
        const prefetchPromise = cache.prefetch('test:key', fetcher);

        expect(cache.has('test:key')).toBe(true);
        const result = await prefetchPromise;
        expect(result).toBe('prefetched result');

        const consumed = cache.get('test:key');
        expect(consumed).toBe('prefetched result');
    });

    test('prevents duplicate in-flight prefetches for the same key', () => {
        const fetcher = jest.fn().mockImplementation(() => new Promise(() => {}));
        const p1 = cache.prefetch('test:key', fetcher);
        const p2 = cache.prefetch('test:key', fetcher);

        expect(p1).toBe(p2);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test('getOrAwait uses pre-cached result if available', async () => {
        cache.set('test:key', 'cached message');
        const fallback = jest.fn();

        const res = await cache.getOrAwait('test:key', fallback);
        expect(res).toBe('cached message');
        expect(fallback).not.toHaveBeenCalled();
    });

    test('getOrAwait awaits in-flight prefetch', async () => {
        let resolveFetch;
        const fetcher = () => new Promise(res => { resolveFetch = res; });
        cache.prefetch('test:key', fetcher);

        const fallback = jest.fn();
        const awaitPromise = cache.getOrAwait('test:key', fallback);

        resolveFetch('async result');
        const res = await awaitPromise;

        expect(res).toBe('async result');
        expect(fallback).not.toHaveBeenCalled();
    });

    test('getOrAwait falls back to live fetcher if in-flight prefetch times out', async () => {
        const fetcher = () => new Promise(() => {}); // hangs
        cache.prefetch('test:key', fetcher);

        const fallback = jest.fn().mockResolvedValue('live fallback');

        const getPromise = cache.getOrAwait('test:key', fallback, 1000);
        jest.advanceTimersByTime(1500);

        const res = await getPromise;
        expect(res).toBe('live fallback');
        expect(fallback).toHaveBeenCalledTimes(1);
    });

    test('clear and clearPrefix remove matching entries', () => {
        cache.set('timer:channel1:t1', 'v1');
        cache.set('timer:channel1:t2', 'v2');
        cache.set('timer:channel2:t1', 'v3');

        cache.clearPrefix('timer:channel1:');

        expect(cache.has('timer:channel1:t1')).toBe(false);
        expect(cache.has('timer:channel1:t2')).toBe(false);
        expect(cache.has('timer:channel2:t1')).toBe(true);

        cache.clearAll();
        expect(cache.has('timer:channel2:t1')).toBe(false);
    });
});
