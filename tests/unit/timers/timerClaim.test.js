// tests/unit/timers/timerClaim.test.js
import { createFakeFirestore } from '../../fixtures/fakeFirestore.js';
import { claimTimerRun, CLAIM_SLACK_MS } from '../../../src/components/timers/timersStorage.js';

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

const PATH = 'channelTimers/111/timers/gaming_news';
const INTERVAL_MS = 30 * 60 * 1000;

describe('claimTimerRun', () => {
    beforeEach(() => {
        mockDb.current = createFakeFirestore();
    });

    test('claims a timer that has never run and stamps lastRunAt', async () => {
        mockDb.current._seed(PATH, { response: 'x', lastRunAt: null });

        const result = await claimTimerRun('parfaitfair', 'gaming_news', INTERVAL_MS);

        expect(result.claimed).toBe(true);
        expect(mockDb.current._read(PATH).lastRunAt).toBeInstanceOf(Date);
    });

    test('three instances racing for the same run: exactly one wins', async () => {
        // The incident: three cold-started instances all saw the same stale
        // lastRunAt and each posted gaming_news within a second of each other.
        mockDb.current._seed(PATH, { response: 'x', lastRunAt: new Date(Date.now() - INTERVAL_MS - 60000) });

        const results = await Promise.all([
            claimTimerRun('parfaitfair', 'gaming_news', INTERVAL_MS),
            claimTimerRun('parfaitfair', 'gaming_news', INTERVAL_MS),
            claimTimerRun('parfaitfair', 'gaming_news', INTERVAL_MS),
        ]);

        expect(results.filter(r => r.claimed)).toHaveLength(1);
        const losers = results.filter(r => !r.claimed);
        expect(losers).toHaveLength(2);
        for (const loser of losers) {
            expect(loser.lastRunAtMs).toBeGreaterThan(Date.now() - 5000);
        }
    });

    test('the owner\'s own next run is claimable despite server-timestamp drift', async () => {
        // Written a moment after the local fire time the owner scheduled from.
        mockDb.current._seed(PATH, { response: 'x', lastRunAt: new Date(Date.now() - INTERVAL_MS + CLAIM_SLACK_MS / 2) });

        const result = await claimTimerRun('parfaitfair', 'gaming_news', INTERVAL_MS);

        expect(result.claimed).toBe(true);
    });

    test('a deleted timer is never claimed', async () => {
        const result = await claimTimerRun('parfaitfair', 'gaming_news', INTERVAL_MS);
        expect(result.claimed).toBe(false);
    });
});
