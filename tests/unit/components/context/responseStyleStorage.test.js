// tests/unit/components/context/responseStyleStorage.test.js

const mockDocs = [];
const mockSet = jest.fn().mockResolvedValue();
const mockDoc = jest.fn(() => ({ set: mockSet }));
const mockUnsubscribe = jest.fn();
let mockSnapshotHandler = null;
const mockCollection = jest.fn(() => ({
    get: jest.fn(async () => ({ forEach: (cb) => mockDocs.forEach(cb) })),
    doc: mockDoc,
    onSnapshot: jest.fn((onNext) => {
        mockSnapshotHandler = onNext;
        return mockUnsubscribe;
    }),
}));

jest.mock('../../../../src/lib/firestore.js', () => ({
    getFirestore: jest.fn(() => ({ collection: mockCollection })),
}));

jest.mock('../../../../src/lib/allowList.js', () => ({
    getBroadcasterIdForChannel: jest.fn(),
    getChannelNameForBroadcasterId: jest.fn(),
}));

jest.mock('../../../../src/lib/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const {
    normalizeDeslop,
    loadAllResponseStyles,
    isDeslopEnabled,
    isDeslopEnabledById,
    setDeslopEnabled,
    onResponseStyleChanges,
    _clearResponseStyleCache,
} = require('../../../../src/components/context/responseStyleStorage.js');

const { getBroadcasterIdForChannel } = require('../../../../src/lib/allowList.js');

const doc = (id, data) => ({ id, data: () => data });
const change = (type, id, data) => ({ type, doc: doc(id, data) });

beforeEach(() => {
    jest.clearAllMocks();
    _clearResponseStyleCache();
    mockDocs.length = 0;
    mockSnapshotHandler = null;
    getBroadcasterIdForChannel.mockImplementation(name => ({ alpha: '111', beta: '222' }[name] || null));
});

describe('normalizeDeslop', () => {
    it('is on only for a literal true', () => {
        expect(normalizeDeslop({ deslop: true })).toBe(true);
        expect(normalizeDeslop({ deslop: 'true' })).toBe(false);
        expect(normalizeDeslop({ deslop: 1 })).toBe(false);
        expect(normalizeDeslop({ deslop: false })).toBe(false);
        expect(normalizeDeslop({})).toBe(false);
        expect(normalizeDeslop(null)).toBe(false);
    });
});

describe('loadAllResponseStyles', () => {
    it('caches the channels that have De-Slop on', async () => {
        mockDocs.push(doc('111', { deslop: true }), doc('222', { deslop: false }));

        expect(await loadAllResponseStyles()).toBe(1);

        expect(mockCollection).toHaveBeenCalledWith('channelResponseStyles');
        expect(isDeslopEnabledById('111')).toBe(true);
        expect(isDeslopEnabledById('222')).toBe(false);
    });
});

describe('isDeslopEnabled', () => {
    beforeEach(async () => {
        mockDocs.push(doc('111', { deslop: true }));
        await loadAllResponseStyles();
    });

    it('resolves a login, with or without the # prefix, to its broadcaster ID', () => {
        expect(isDeslopEnabled('alpha')).toBe(true);
        expect(isDeslopEnabled('#Alpha')).toBe(true);
        expect(isDeslopEnabled('beta')).toBe(false);
    });

    it('is off for a channel with no known broadcaster ID, and for no channel', () => {
        expect(isDeslopEnabled('unknown')).toBe(false);
        expect(isDeslopEnabled(null)).toBe(false);
        expect(isDeslopEnabledById(null)).toBe(false);
    });
});

describe('setDeslopEnabled', () => {
    it('writes a merge keyed by broadcaster ID and updates the cache', async () => {
        await setDeslopEnabled('#Alpha', true);

        expect(mockDoc).toHaveBeenCalledWith('111');
        expect(mockSet).toHaveBeenCalledWith(
            { deslop: true, channelName: 'alpha', updatedAt: expect.any(Date) },
            { merge: true },
        );
        expect(isDeslopEnabled('alpha')).toBe(true);

        await setDeslopEnabled('alpha', false);
        expect(mockSet).toHaveBeenLastCalledWith(expect.objectContaining({ deslop: false }), { merge: true });
        expect(isDeslopEnabled('alpha')).toBe(false);
    });

    it('throws for a channel with no known broadcaster ID instead of keying by login', async () => {
        await expect(setDeslopEnabled('unknown', true)).rejects.toThrow();
        expect(mockSet).not.toHaveBeenCalled();
    });

    it('leaves the cache alone when the write fails', async () => {
        mockSet.mockRejectedValueOnce(new Error('unavailable'));
        await expect(setDeslopEnabled('alpha', true)).rejects.toThrow('unavailable');
        expect(isDeslopEnabled('alpha')).toBe(false);
    });
});

describe('onResponseStyleChanges', () => {
    it('updates the cache and calls back when the setting changes', () => {
        const callback = jest.fn();
        const unsubscribe = onResponseStyleChanges(callback);

        mockSnapshotHandler({ docChanges: () => [change('added', '111', { deslop: true })] });
        expect(isDeslopEnabledById('111')).toBe(true);
        expect(callback).toHaveBeenCalledWith({ twitchUserId: '111', deslop: true });

        mockSnapshotHandler({ docChanges: () => [change('modified', '111', { deslop: false })] });
        expect(isDeslopEnabledById('111')).toBe(false);
        expect(callback).toHaveBeenLastCalledWith({ twitchUserId: '111', deslop: false });

        expect(unsubscribe).toBe(mockUnsubscribe);
    });

    it('treats a removed document as off', () => {
        const callback = jest.fn();
        onResponseStyleChanges(callback);
        mockSnapshotHandler({ docChanges: () => [change('added', '111', { deslop: true })] });

        mockSnapshotHandler({ docChanges: () => [change('removed', '111', { deslop: true })] });

        expect(isDeslopEnabledById('111')).toBe(false);
        expect(callback).toHaveBeenLastCalledWith({ twitchUserId: '111', deslop: false });
    });

    it('does not call back when the effective setting is unchanged', async () => {
        const callback = jest.fn();
        onResponseStyleChanges(callback);
        await setDeslopEnabled('alpha', true);

        // The bot's own write coming back, and the initial snapshot of an "off" doc.
        mockSnapshotHandler({ docChanges: () => [
            change('modified', '111', { deslop: true }),
            change('added', '222', { deslop: false }),
        ] });

        expect(callback).not.toHaveBeenCalled();
    });

    it('keeps processing changes when the callback throws', () => {
        const callback = jest.fn(() => { throw new Error('boom'); });
        onResponseStyleChanges(callback);

        mockSnapshotHandler({ docChanges: () => [
            change('added', '111', { deslop: true }),
            change('added', '222', { deslop: true }),
        ] });

        expect(callback).toHaveBeenCalledTimes(2);
        expect(isDeslopEnabledById('222')).toBe(true);
    });
});
