// tests/unit/lib/channelOwnership.test.js
// Two copies of the module are loaded against one fake Firestore to stand in
// for two Cloud Run instances competing for the same channels.
import { createFakeFirestore } from '../../fixtures/fakeFirestore.js';

const mockDb = { current: null };
const mockConfig = { app: { revision: 'rev-1' }, cluster: { channelOwnershipEnabled: true } };

jest.mock('../../../src/lib/logger.js');
jest.mock('../../../src/config/index.js', () => ({ __esModule: true, default: mockConfig }));
jest.mock('../../../src/lib/firestore.js', () => {
    const { FieldValue } = jest.requireActual('@google-cloud/firestore');
    return { getFirestore: () => mockDb.current, FieldValue };
});
jest.mock('../../../src/lib/allowList.js', () => ({
    getBroadcasterIdForChannel: (name) => ({ parfaitfair: '111', otherchan: '222' })[String(name).replace(/^#/, '').toLowerCase()] || null,
}));

const PARFAIT = { broadcasterId: '111', channelName: 'parfaitfair' };
const OTHER = { broadcasterId: '222', channelName: 'otherchan' };

/** Loads a fresh copy of the module: a separate "instance" with its own ID. */
function loadInstance() {
    let mod;
    jest.isolateModules(() => {
        mod = require('../../../src/lib/channelOwnership.js');
    });
    return mod;
}

describe('channelOwnership', () => {
    let a;
    let b;

    beforeEach(() => {
        mockDb.current = createFakeFirestore();
        mockConfig.cluster.channelOwnershipEnabled = true;
        a = loadInstance();
        b = loadInstance();
    });

    afterEach(async () => {
        a._reset();
        b._reset();
        jest.useRealTimers();
    });

    test('each instance gets a distinct ID', () => {
        expect(a.getInstanceId()).not.toBe(b.getInstanceId());
        expect(a.getInstanceId()).toMatch(/^rev-1-/);
    });

    test('only one instance can hold a channel', async () => {
        const first = await a.claimChannel(PARFAIT.broadcasterId, PARFAIT.channelName);
        const second = await b.claimChannel(PARFAIT.broadcasterId, PARFAIT.channelName);

        expect(first.owned).toBe(true);
        expect(second).toEqual({ owned: false, ownerId: a.getInstanceId() });
        expect(a.ownsChannel('parfaitfair')).toBe(true);
        expect(a.ownsChannel('#parfaitfair')).toBe(true);
        expect(b.ownsChannel('parfaitfair')).toBe(false);
    });

    test('renewing a held lease keeps ownership and does not re-announce it', async () => {
        const events = [];
        a.onOwnershipChange(e => events.push(e.type));

        await a.claimChannel(PARFAIT.broadcasterId, PARFAIT.channelName);
        await a.claimChannel(PARFAIT.broadcasterId, PARFAIT.channelName);

        expect(events).toEqual(['acquired']);
    });

    test('an expired lease can be taken over, and the old holder learns it lost', async () => {
        const lostEvents = [];
        a.onOwnershipChange(e => { if (e.type === 'lost') lostEvents.push(e); });

        await a.claimChannel(PARFAIT.broadcasterId, PARFAIT.channelName);
        // The holder stopped renewing (crashed, frozen, or partitioned).
        const lease = mockDb.current._read('channelLeases/111');
        mockDb.current._seed('channelLeases/111', { ...lease, expiresAt: new Date(Date.now() - 1000) });

        const takeover = await b.claimChannel(PARFAIT.broadcasterId, PARFAIT.channelName);
        expect(takeover.owned).toBe(true);
        expect(mockDb.current._read('channelLeases/111').previousOwnerId).toBe(a.getInstanceId());

        // A's next renewal discovers the takeover.
        const renewal = await a.claimChannel(PARFAIT.broadcasterId, PARFAIT.channelName);
        expect(renewal.owned).toBe(false);
        expect(a.ownsChannel('parfaitfair')).toBe(false);
        expect(lostEvents).toEqual([expect.objectContaining({ broadcasterId: '111', reason: 'taken' })]);
    });

    test('stops acting before the lease could expire', async () => {
        jest.useFakeTimers({ now: Date.now() });
        await a.claimChannel(PARFAIT.broadcasterId, PARFAIT.channelName);
        expect(a.ownsChannel('parfaitfair')).toBe(true);

        jest.setSystemTime(Date.now() + a.LEASE_TTL_MS - a.SAFETY_MARGIN_MS + 1);
        expect(a.ownsChannel('parfaitfair')).toBe(false);
    });

    test('concurrent claims for one channel share a single transaction', async () => {
        const spy = jest.spyOn(mockDb.current, 'runTransaction');
        const events = [];
        a.onOwnershipChange(e => events.push(e.type));

        await Promise.all([
            a.claimChannel(PARFAIT.broadcasterId, PARFAIT.channelName),
            a.claimChannel(PARFAIT.broadcasterId, PARFAIT.channelName),
        ]);

        expect(spy).toHaveBeenCalledTimes(1);
        expect(events).toEqual(['acquired']);
    });

    test('startup sweep claims live channels nobody holds', async () => {
        await a.startChannelOwnership({
            getCandidates: () => [PARFAIT, OTHER],
            isChannelLive: (name) => name === 'parfaitfair',
        });

        expect(a.getOwnedChannelNames()).toEqual(['parfaitfair']);
        // Offline channels are not leased until something happens in them.
        expect(mockDb.current._read('channelLeases/222')).toBeUndefined();
        expect(mockDb.current._read(`botInstances/${a.getInstanceId()}`)).toBeDefined();
    });

    test('sweep splits live channels between live instances', async () => {
        const live = () => true;
        const candidates = () => [PARFAIT, OTHER];
        // B is already running and heartbeating when A starts.
        mockDb.current._seed(`botInstances/${b.getInstanceId()}`, { expiresAt: new Date(Date.now() + 30000) });

        await a.startChannelOwnership({ getCandidates: candidates, isChannelLive: live });
        await b.startChannelOwnership({ getCandidates: candidates, isChannelLive: live });

        expect(a.getOwnedChannelNames()).toHaveLength(1);
        expect(b.getOwnedChannelNames()).toHaveLength(1);
        expect(new Set([...a.getOwnedChannelNames(), ...b.getOwnedChannelNames()]))
            .toEqual(new Set(['parfaitfair', 'otherchan']));
    });

    test('sweep leaves channels a peer holds alone instead of retrying them every pass', async () => {
        const live = () => true;
        const candidates = () => [PARFAIT, OTHER];
        // Three instances share two live channels, so fairShare rounds up to 1
        // and an instance holding none keeps looking for orphans every sweep.
        mockDb.current._seed('botInstances/peer-2', { expiresAt: new Date(Date.now() + 30000) });
        await a.claimChannel(PARFAIT.broadcasterId, PARFAIT.channelName);
        await a.claimChannel(OTHER.broadcasterId, OTHER.channelName);
        mockDb.current._seed(`botInstances/${a.getInstanceId()}`, { expiresAt: new Date(Date.now() + 30000) });
        const spy = jest.spyOn(mockDb.current, 'runTransaction');

        await b.startChannelOwnership({ getCandidates: candidates, isChannelLive: live });
        await b._sweep();

        expect(b.getOwnedChannelNames()).toEqual([]);
        expect(spy).not.toHaveBeenCalled();
    });

    test('sweep still claims a channel whose owner stopped renewing', async () => {
        await a.claimChannel(PARFAIT.broadcasterId, PARFAIT.channelName);
        const lease = mockDb.current._read('channelLeases/111');
        mockDb.current._seed('channelLeases/111', { ...lease, expiresAt: new Date(Date.now() - 1000) });

        await b.startChannelOwnership({ getCandidates: () => [PARFAIT], isChannelLive: () => true });

        expect(b.getOwnedChannelNames()).toEqual(['parfaitfair']);
    });

    test('renewal keeps the handover fields written at acquisition', async () => {
        mockDb.current._seed('channelLeases/111', {
            ownerId: 'dead-instance',
            channelName: 'parfaitfair',
            expiresAt: new Date(Date.now() - 1000),
        });
        await a.claimChannel(PARFAIT.broadcasterId, PARFAIT.channelName);
        const acquiredAt = mockDb.current._read('channelLeases/111').acquiredAt;

        await a.claimChannel(PARFAIT.broadcasterId, PARFAIT.channelName);

        const renewed = mockDb.current._read('channelLeases/111');
        expect(renewed.previousOwnerId).toBe('dead-instance');
        expect(renewed.acquiredAt?.getTime()).toBe(acquiredAt.getTime());
    });

    test('a failed claim remembers the peer owner briefly', async () => {
        jest.useFakeTimers({ now: Date.now() });
        await a.claimChannel(PARFAIT.broadcasterId, PARFAIT.channelName);
        expect(b.getKnownPeerOwner('111')).toBeNull();

        await b.claimChannel(PARFAIT.broadcasterId, PARFAIT.channelName);
        expect(b.getKnownPeerOwner('111')).toBe(a.getInstanceId());

        // Trusted for a few seconds only, so a peer that released on shutdown
        // stops being forwarded to soon after.
        jest.setSystemTime(Date.now() + b.PEER_CACHE_MS + 1);
        expect(b.getKnownPeerOwner('111')).toBeNull();
    });

    test('taking a channel over forgets the cached peer', async () => {
        await a.claimChannel(PARFAIT.broadcasterId, PARFAIT.channelName);
        await b.claimChannel(PARFAIT.broadcasterId, PARFAIT.channelName);
        await a.stopChannelOwnership();

        await b.claimChannel(PARFAIT.broadcasterId, PARFAIT.channelName);

        expect(b.getKnownPeerOwner('111')).toBeNull();
        expect(b.ownsChannel('parfaitfair')).toBe(true);
    });

    test('release deletes the lease before announcing the loss', async () => {
        await a.claimChannel(PARFAIT.broadcasterId, PARFAIT.channelName);
        let leaseAtLoss = 'not called';
        a.onOwnershipChange(({ type }) => {
            if (type === 'lost') leaseAtLoss = mockDb.current._read('channelLeases/111');
        });

        await a.stopChannelOwnership();

        // Listeners (the inbox) close only once peers can no longer route here.
        expect(leaseAtLoss).toBeUndefined();
    });

    test('renewals run concurrently so one slow channel cannot starve the rest', async () => {
        await a.claimChannel(PARFAIT.broadcasterId, PARFAIT.channelName);
        await a.claimChannel(OTHER.broadcasterId, OTHER.channelName);

        const realTransaction = mockDb.current.runTransaction;
        let releaseFirst;
        const firstHeld = new Promise(resolve => { releaseFirst = resolve; });
        let started = 0;
        mockDb.current.runTransaction = jest.fn(async (fn) => {
            started += 1;
            if (started === 1) await firstHeld;
            return realTransaction(fn);
        });

        const sweeping = a._sweep();
        await new Promise(resolve => setImmediate(resolve));
        expect(started).toBe(2);

        releaseFirst();
        await sweeping;
        expect(a.getOwnedChannelNames().sort()).toEqual(['otherchan', 'parfaitfair']);
    });

    test('an idle offline channel is released', async () => {
        jest.useFakeTimers({ now: Date.now() });
        let live = true;
        await a.startChannelOwnership({ getCandidates: () => [PARFAIT], isChannelLive: () => live });
        expect(a.getOwnedChannelNames()).toEqual(['parfaitfair']);

        live = false;
        jest.setSystemTime(Date.now() + a.IDLE_RELEASE_MS + 1);
        // The lease itself would have lapsed over that span; keep it valid so
        // the idle rule is what is being tested.
        a._getOwned().get('111').deadlineMs = Date.now() + 10000;
        await a._sweep();

        expect(a.getOwnedChannelNames()).toEqual([]);
        expect(mockDb.current._read('channelLeases/111')).toBeUndefined();
    });

    test('recent activity keeps an offline channel held', async () => {
        jest.useFakeTimers({ now: Date.now() });
        await a.claimChannel(PARFAIT.broadcasterId, PARFAIT.channelName);
        a._getOwned().get('111').lastActivityMs = Date.now() - a.IDLE_RELEASE_MS - 1;
        a.touchBroadcaster('111');

        await a.startChannelOwnership({ getCandidates: () => [PARFAIT], isChannelLive: () => false });

        expect(a.getOwnedChannelNames()).toEqual(['parfaitfair']);
    });

    test('shutdown releases leases so another instance can take over at once', async () => {
        await a.claimChannel(PARFAIT.broadcasterId, PARFAIT.channelName);
        await a.stopChannelOwnership();

        expect(mockDb.current._read('channelLeases/111')).toBeUndefined();
        expect((await b.claimChannel(PARFAIT.broadcasterId, PARFAIT.channelName)).owned).toBe(true);
    });

    test('release never deletes a lease another instance now holds', async () => {
        await a.claimChannel(PARFAIT.broadcasterId, PARFAIT.channelName);
        mockDb.current._seed('channelLeases/111', {
            ownerId: b.getInstanceId(),
            channelName: 'parfaitfair',
            expiresAt: new Date(Date.now() + 30000),
        });

        await a.stopChannelOwnership();

        expect(mockDb.current._read('channelLeases/111').ownerId).toBe(b.getInstanceId());
    });

    describe('when disabled', () => {
        beforeEach(() => {
            mockConfig.cluster.channelOwnershipEnabled = false;
        });

        test('this process owns every channel and never touches Firestore', async () => {
            const spy = jest.spyOn(mockDb.current, 'runTransaction');

            await a.startChannelOwnership({ getCandidates: () => [PARFAIT], isChannelLive: () => true });

            expect(a.ownsChannel('parfaitfair')).toBe(true);
            expect(a.ownsChannel('unknownchan')).toBe(true);
            expect((await a.claimChannel('111', 'parfaitfair')).owned).toBe(true);
            expect(await a.whenOwnershipReady()).toBe(true);
            expect(spy).not.toHaveBeenCalled();
        });
    });
});
