// tests/unit/lib/baseGameStorage.test.js
//
// Player stats docs are keyed by the player's Twitch user ID, and the
// per-channel map inside each doc by the broadcaster ID.

const mockSet = jest.fn();
const mockDoc = jest.fn(() => ({ set: mockSet }));
const mockGet = jest.fn();
const mockLimit = jest.fn(() => ({ get: mockGet }));
const mockOrderBy = jest.fn(() => ({ limit: mockLimit }));
const mockWhere = jest.fn(() => ({ limit: mockLimit }));
const mockCollection = jest.fn(() => ({
    doc: mockDoc,
    orderBy: mockOrderBy,
    where: mockWhere,
}));

const mockBatchUpdate = jest.fn();
const mockBatchCommit = jest.fn();

jest.mock('../../../src/lib/firestore.js', () => ({
    getFirestore: jest.fn(() => ({
        collection: mockCollection,
        batch: () => ({ update: mockBatchUpdate, commit: mockBatchCommit }),
    })),
    FieldValue: {
        increment: jest.fn(n => `inc(${n})`),
        serverTimestamp: jest.fn(() => 'ts'),
        delete: jest.fn(() => 'del'),
    },
}));

jest.mock('../../../src/lib/channelKey.js', () => ({
    channelDocKey: jest.fn((name) => {
        const ids = { somechannel: '987654' };
        const login = String(name).toLowerCase().replace(/^#/, '');
        if (!ids[login]) throw new Error(`unresolved ${login}`);
        return ids[login];
    }),
    normalizeChannelName: jest.fn(name => String(name).toLowerCase().replace(/^#/, '')),
}));

jest.mock('../../../src/lib/logger.js', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { BaseGameStorage, playerLabel } from '../../../src/lib/baseGameStorage.js';
import logger from '../../../src/lib/logger.js';

function snapshotOf(docs) {
    return { forEach: fn => docs.forEach(fn), docs, empty: docs.length === 0, size: docs.length };
}

describe('BaseGameStorage player stats', () => {
    let storage;

    beforeEach(() => {
        jest.clearAllMocks();
        storage = new BaseGameStorage({
            gameName: 'Test',
            configCollection: 'testConfigs',
            statsCollection: 'testPlayerStats',
            historyCollection: 'testHistory',
        });
    });

    describe('updatePlayerScore', () => {
        it('writes the doc keyed by user ID with the broadcaster-ID channel map and the login', async () => {
            await storage.updatePlayerScore('12345', 'SomeUser', 'SomeChannel', 10, 'SomeUser_Display');

            expect(mockCollection).toHaveBeenCalledWith('testPlayerStats');
            expect(mockDoc).toHaveBeenCalledWith('12345');
            const [data, opts] = mockSet.mock.calls[0];
            expect(opts).toEqual({ merge: true });
            expect(data.login).toBe('someuser');
            expect(data.displayName).toBe('SomeUser_Display');
            expect(data.globalPoints).toBe('inc(10)');
            expect(Object.keys(data.channels)).toEqual(['987654']);
            expect(data.channels['987654']).toEqual(expect.objectContaining({
                points: 'inc(10)',
                successes: 'inc(1)',
                participation: 'inc(1)',
            }));
        });

        it('stores a numeric user ID as a string doc ID', async () => {
            await storage.updatePlayerScore(12345, 'someuser', 'somechannel', 1);
            expect(mockDoc).toHaveBeenCalledWith('12345');
            expect(mockSet.mock.calls[0][0].displayName).toBe('someuser');
        });

        it('skips the write and warns when no user ID is known', async () => {
            await storage.updatePlayerScore(null, 'someuser', 'somechannel', 5, 'SomeUser');
            await storage.updatePlayerScore(undefined, 'someuser', 'somechannel', 5, 'SomeUser');

            expect(mockDoc).not.toHaveBeenCalled();
            expect(mockSet).not.toHaveBeenCalled();
            expect(logger.warn).toHaveBeenCalledTimes(2);
        });

        it('raises a StorageError rather than writing for a channel with no broadcaster ID', async () => {
            await expect(storage.updatePlayerScore('12345', 'someuser', 'unknownchannel', 5))
                .rejects.toMatchObject({ name: 'StorageError' });
            expect(mockSet).not.toHaveBeenCalled();
        });
    });

    describe('getLeaderboard', () => {
        it('orders by the broadcaster-ID channel map and labels players by display name, then login', async () => {
            mockGet.mockResolvedValueOnce(snapshotOf([
                { id: '1', data: () => ({ displayName: 'Alice', login: 'alice', channels: { '987654': { points: 30, successes: 3, participation: 4 } } }) },
                { id: '2', data: () => ({ login: 'bob', channels: { '987654': { points: 20, successes: 2, participation: 2 } } }) },
                { id: '3', data: () => ({ channels: { '987654': { points: 10, successes: 1, participation: 1 } } }) },
            ]));

            const rows = await storage.getLeaderboard('somechannel', 5);

            expect(mockOrderBy).toHaveBeenCalledWith('channels.987654.points', 'desc');
            expect(rows).toEqual([
                { id: '1', data: { displayName: 'Alice', channelPoints: 30, channelSuccesses: 3, channelParticipation: 4 } },
                { id: '2', data: { displayName: 'bob', channelPoints: 20, channelSuccesses: 2, channelParticipation: 2 } },
                { id: '3', data: { displayName: '3', channelPoints: 10, channelSuccesses: 1, channelParticipation: 1 } },
            ]);
        });

        it('falls back to a participation filter on the broadcaster-ID map when the index is missing', async () => {
            mockGet
                .mockRejectedValueOnce(new Error('index missing'))
                .mockResolvedValueOnce(snapshotOf([
                    { id: '2', data: () => ({ login: 'bob', channels: { '987654': { points: 5 } } }) },
                ]));

            const rows = await storage.getLeaderboard('somechannel', 5);

            expect(mockWhere).toHaveBeenCalledWith('channels.987654.participation', '>', 0);
            expect(rows).toEqual([
                { id: '2', data: { displayName: 'bob', channelPoints: 5, channelSuccesses: 0, channelParticipation: 0 } },
            ]);
        });

        it('labels global leaderboard rows by login when no display name is stored', async () => {
            mockGet.mockResolvedValueOnce(snapshotOf([
                { id: '2', data: () => ({ login: 'bob', globalPoints: 7 }) },
            ]));

            const rows = await storage.getLeaderboard(null, 5);

            expect(mockOrderBy).toHaveBeenCalledWith('globalPoints', 'desc');
            expect(rows[0]).toEqual({ id: '2', data: { displayName: 'bob', points: 7, successes: 0, participation: 0 } });
        });
    });

    describe('clearChannelLeaderboardData', () => {
        it('deletes the broadcaster-ID channel map from each player doc', async () => {
            const ref = { id: 'ref-1' };
            mockGet.mockResolvedValueOnce(snapshotOf([{ id: '1', ref }]));

            const result = await storage.clearChannelLeaderboardData('somechannel');

            expect(mockWhere).toHaveBeenCalledWith('channels.987654', '!=', null);
            expect(mockBatchUpdate).toHaveBeenCalledWith(ref, { 'channels.987654': 'del' });
            expect(result).toEqual(expect.objectContaining({ success: true, clearedCount: 1 }));
        });
    });

    describe('playerLabel', () => {
        it('prefers display name, then login, then the doc ID', () => {
            expect(playerLabel('1', { displayName: 'Alice', login: 'alice' })).toBe('Alice');
            expect(playerLabel('1', { login: 'alice' })).toBe('alice');
            expect(playerLabel('1', {})).toBe('1');
            expect(playerLabel('1', undefined)).toBe('1');
        });
    });
});
