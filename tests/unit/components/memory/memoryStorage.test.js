// tests/unit/components/memory/memoryStorage.test.js

const mockItemDocs = [];
let mockParentDoc = { exists: false, data: () => ({}) };
let mockPendingDoc = { exists: false, data: () => ({}) };

const mockParentSet = jest.fn().mockResolvedValue();
const mockItemSet = jest.fn().mockResolvedValue();
const mockItemDelete = jest.fn().mockResolvedValue();
const mockItemAdd = jest.fn(async () => ({ id: 'generated-id' }));
const mockPendingSet = jest.fn().mockResolvedValue();
const mockPendingDelete = jest.fn().mockResolvedValue();
const mockChannelDocFn = jest.fn();
const mockPendingDocFn = jest.fn();

// Channel documents are keyed by broadcaster ID, resolved through the allow-list.
const BROADCASTER_ID = '4242';
jest.mock('../../../../src/lib/allowList.js', () => ({
    getBroadcasterIdForChannel: jest.fn((name) => (String(name).toLowerCase() === 'chan' ? '4242' : null)),
    getChannelNameForBroadcasterId: jest.fn((id) => (id === '4242' ? 'chan' : null)),
}));

jest.mock('../../../../src/lib/firestore.js', () => {
    const items = {
        get: jest.fn(async () => ({ forEach: (cb) => mockItemDocs.forEach(cb) })),
        add: (...args) => mockItemAdd(...args),
        doc: jest.fn(() => ({ set: mockItemSet, delete: mockItemDelete })),
    };
    mockPendingDocFn.mockImplementation(() => ({ get: jest.fn(async () => mockPendingDoc), set: mockPendingSet, delete: mockPendingDelete }));
    mockChannelDocFn.mockImplementation(() => ({
        get: jest.fn(async () => mockParentDoc),
        set: mockParentSet,
        collection: jest.fn(() => items),
    }));
    const collection = jest.fn((name) => {
        if (name === 'channelMemoryPending') {
            return { doc: mockPendingDocFn };
        }
        return { doc: mockChannelDocFn };
    });
    return {
        getFirestore: jest.fn(() => ({ collection })),
        FieldValue: {
            arrayUnion: (...values) => ({ __arrayUnion: values }),
            increment: (n) => ({ __increment: n }),
        },
    };
});

jest.mock('../../../../src/lib/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const {
    loadChannelMemories,
    addMemory,
    addOptOut,
    setChannelMemoryEnabled,
    bumpUsage,
    savePendingMessages,
    takePendingMessages,
    MemoryStorageError,
} = require('../../../../src/components/memory/memoryStorage.js');

beforeEach(() => {
    jest.clearAllMocks();
    mockItemDocs.length = 0;
    mockParentDoc = { exists: false, data: () => ({}) };
    mockPendingDoc = { exists: false, data: () => ({}) };
});

describe('loadChannelMemories', () => {
    it('treats a channel with no settings doc as enabled with no opt-outs', async () => {
        mockItemDocs.push({ id: 'm1', data: () => ({ text: 'Gary is the duck.', keys: ['gary'] }) });
        const result = await loadChannelMemories('Chan');
        expect(result).toEqual({
            memories: [{ id: 'm1', text: 'Gary is the duck.', keys: ['gary'] }],
            optedOut: [],
            enabled: true,
        });
    });

    it('keys the channel document by broadcaster ID, not login', async () => {
        await loadChannelMemories('#Chan');
        expect(mockChannelDocFn).toHaveBeenCalledWith(BROADCASTER_ID);
        expect(mockChannelDocFn).not.toHaveBeenCalledWith('chan');
    });

    it('refuses a channel with no known broadcaster ID rather than keying by name', async () => {
        await expect(loadChannelMemories('unknown')).rejects.toBeInstanceOf(MemoryStorageError);
        expect(mockChannelDocFn).not.toHaveBeenCalled();
    });

    it('reads the channel opt-out and user opt-outs', async () => {
        mockParentDoc = { exists: true, data: () => ({ enabled: false, optedOut: ['bob'] }) };
        const result = await loadChannelMemories('chan');
        expect(result.enabled).toBe(false);
        expect(result.optedOut).toEqual(['bob']);
    });
});

describe('writes', () => {
    it('addMemory stores counters and returns the id', async () => {
        const stored = await addMemory('chan', { text: 'Gary is the duck.', keys: ['gary'], source: 'manual', addedBy: 'mod' });
        expect(stored.id).toBe('generated-id');
        expect(mockItemAdd).toHaveBeenCalledWith(expect.objectContaining({
            text: 'Gary is the duck.', keys: ['gary'], subjects: [], source: 'manual', addedBy: 'mod', mentions: 1, useCount: 0,
        }));
    });

    it('wraps Firestore failures', async () => {
        mockItemAdd.mockRejectedValueOnce(new Error('unavailable'));
        await expect(addMemory('chan', { text: 'x', keys: ['xyz'] })).rejects.toBeInstanceOf(MemoryStorageError);
    });

    it('addOptOut and setChannelMemoryEnabled merge into the channel doc', async () => {
        await addOptOut('chan', 'Bob');
        expect(mockChannelDocFn).toHaveBeenCalledWith(BROADCASTER_ID);
        expect(mockParentSet).toHaveBeenCalledWith(expect.objectContaining({ channelName: 'chan', optedOut: { __arrayUnion: ['bob'] } }), { merge: true });
        await setChannelMemoryEnabled('chan', false);
        expect(mockParentSet).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }), { merge: true });
    });

    it('bumpUsage increments without throwing on failure', async () => {
        mockItemSet.mockRejectedValueOnce(new Error('nope'));
        expect(() => bumpUsage('chan', ['m1', 'm2'])).not.toThrow();
        expect(mockItemSet).toHaveBeenCalledTimes(2);
        expect(mockItemSet).toHaveBeenCalledWith(expect.objectContaining({ useCount: { __increment: 1 } }), { merge: true });
    });

    it('bumpUsage is a no-op for a channel with no known broadcaster ID', () => {
        expect(() => bumpUsage('unknown', ['m1'])).not.toThrow();
        expect(mockItemSet).not.toHaveBeenCalled();
    });
});

describe('pending messages', () => {
    it('round-trips stashed lines and deletes the doc once taken', async () => {
        const lines = [{ username: 'alice', message: 'hi', ts: 1 }];
        await savePendingMessages('chan', lines);
        expect(mockPendingDocFn).toHaveBeenCalledWith(BROADCASTER_ID);
        expect(mockPendingSet).toHaveBeenCalledWith(expect.objectContaining({ channelName: 'chan', messages: lines }));

        mockPendingDoc = { exists: true, data: () => ({ messages: lines }) };
        expect(await takePendingMessages('chan')).toEqual(lines);
        expect(mockPendingDelete).toHaveBeenCalledTimes(1);
    });

    it('returns nothing when no stash exists', async () => {
        expect(await takePendingMessages('chan')).toEqual([]);
        expect(mockPendingDelete).not.toHaveBeenCalled();
    });
});
