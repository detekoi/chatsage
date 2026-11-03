// tests/unit/timedGames/timedGamesStorage.test.js
import { createFakeFirestore } from '../../fixtures/fakeFirestore.js';
import {
    normalizeConfig,
    parseGameList,
    getTimedGamesConfig,
    saveTimedGamesConfig,
    claimTimedGameRun,
    CLAIM_SLACK_MS,
    DEFAULT_INTERVAL_MINUTES,
} from '../../../src/components/timedGames/timedGamesStorage.js';

const mockDb = { current: null };

jest.mock('../../../src/lib/logger.js');
jest.mock('../../../src/lib/firestore.js', () => {
    const { FieldValue } = jest.requireActual('@google-cloud/firestore');
    return { getFirestore: () => mockDb.current, FieldValue };
});
jest.mock('../../../src/lib/allowList.js', () => ({
    getBroadcasterIdForChannel: (name) => (name === 'parfaitfair' ? '111' : null),
    getChannelNameForBroadcasterId: (id) => (id === '111' ? 'parfaitfair' : null),
}));

const PATH = 'timedGameConfigs/111';
const INTERVAL_MS = 30 * 60 * 1000;

describe('timedGamesStorage', () => {
    beforeEach(() => {
        mockDb.current = createFakeFirestore();
    });

    describe('normalizeConfig', () => {
        test('defaults to off with every game', () => {
            expect(normalizeConfig(undefined)).toEqual({
                enabled: false,
                intervalMinutes: DEFAULT_INTERVAL_MINUTES,
                games: ['trivia', 'geo', 'riddle'],
            });
        });

        test('rejects an out-of-range or fractional interval', () => {
            expect(normalizeConfig({ intervalMinutes: 2 }).intervalMinutes).toBe(DEFAULT_INTERVAL_MINUTES);
            expect(normalizeConfig({ intervalMinutes: 10.5 }).intervalMinutes).toBe(DEFAULT_INTERVAL_MINUTES);
            expect(normalizeConfig({ intervalMinutes: 45 }).intervalMinutes).toBe(45);
        });

        test('an empty or unknown game list falls back to every game', () => {
            expect(normalizeConfig({ games: [] }).games).toEqual(['trivia', 'geo', 'riddle']);
            expect(normalizeConfig({ games: ['chess'] }).games).toEqual(['trivia', 'geo', 'riddle']);
        });
    });

    test('parseGameList de-duplicates and keeps canonical order', () => {
        expect(parseGameList('Riddle, trivia riddle chess')).toEqual(['trivia', 'riddle']);
    });

    test('saves settings under the broadcaster ID and reads them back', async () => {
        await saveTimedGamesConfig('parfaitfair', { enabled: true, intervalMinutes: 15, games: ['riddle'], lastGame: 'x' });
        const stored = mockDb.current._read(PATH);
        expect(stored).toEqual(expect.objectContaining({ channelName: 'parfaitfair', enabled: true, intervalMinutes: 15, games: ['riddle'] }));
        expect(stored.lastGame).toBeUndefined();

        const cfg = await getTimedGamesConfig('parfaitfair');
        expect(cfg).toEqual({ enabled: true, intervalMinutes: 15, games: ['riddle'], lastRunAtMs: 0, lastGame: null });
    });

    test('a partial save keeps the other settings', async () => {
        mockDb.current._seed(PATH, { enabled: true, intervalMinutes: 20, games: ['geo'] });
        await saveTimedGamesConfig('parfaitfair', { enabled: false });
        expect(mockDb.current._read(PATH)).toEqual(expect.objectContaining({ enabled: false, intervalMinutes: 20, games: ['geo'] }));
    });

    describe('claimTimedGameRun', () => {
        test('claims a first run and records the game', async () => {
            mockDb.current._seed(PATH, { enabled: true });
            const result = await claimTimedGameRun('parfaitfair', INTERVAL_MS, 'geo');
            expect(result.claimed).toBe(true);
            const stored = mockDb.current._read(PATH);
            expect(stored.lastRunAt).toBeInstanceOf(Date);
            expect(stored.lastGame).toBe('geo');
            expect(stored.enabled).toBe(true);
        });

        test('two instances racing for the same run: exactly one wins', async () => {
            mockDb.current._seed(PATH, { enabled: true, lastRunAt: new Date(Date.now() - INTERVAL_MS - 60000), lastGame: 'trivia' });
            const results = await Promise.all([
                claimTimedGameRun('parfaitfair', INTERVAL_MS, 'geo'),
                claimTimedGameRun('parfaitfair', INTERVAL_MS, 'geo'),
            ]);
            expect(results.filter(r => r.claimed)).toHaveLength(1);
            const loser = results.find(r => !r.claimed);
            expect(loser.lastGame).toBe('geo');
        });

        test('the owner\'s next run is claimable despite server-timestamp drift', async () => {
            mockDb.current._seed(PATH, { lastRunAt: new Date(Date.now() - INTERVAL_MS + CLAIM_SLACK_MS / 2) });
            const result = await claimTimedGameRun('parfaitfair', INTERVAL_MS, 'riddle');
            expect(result.claimed).toBe(true);
        });

        test('a run inside the interval is refused', async () => {
            mockDb.current._seed(PATH, { lastRunAt: new Date(Date.now() - 60 * 1000), lastGame: 'trivia' });
            const result = await claimTimedGameRun('parfaitfair', INTERVAL_MS, 'geo');
            expect(result).toEqual(expect.objectContaining({ claimed: false, lastGame: 'trivia' }));
        });
    });
});
