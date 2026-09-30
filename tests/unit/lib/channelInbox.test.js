// tests/unit/lib/channelInbox.test.js
import { createFakeFirestore } from '../../fixtures/fakeFirestore.js';
import {
    forwardToInbox,
    startInbox,
    stopInbox,
    stopAllInboxes,
    _consume,
    _getInboxes,
    MAX_CHAT_AGE_MS,
} from '../../../src/lib/channelInbox.js';
import { ownsBroadcaster } from '../../../src/lib/channelOwnership.js';

const mockDb = { current: null };

jest.mock('../../../src/lib/logger.js');
jest.mock('../../../src/lib/firestore.js', () => ({ getFirestore: () => mockDb.current }));
jest.mock('../../../src/lib/channelOwnership.js', () => ({
    getInstanceId: () => 'instance-b',
    ownsBroadcaster: jest.fn(() => true),
    touchBroadcaster: jest.fn(),
}));

const CHANNEL_ID = '111';
const chatNotification = {
    subscription: { type: 'channel.chat.message' },
    event: { broadcaster_user_id: CHANNEL_ID, message: { text: 'hi' } },
};

function inboxPath(messageId) {
    return `channelInbox/${CHANNEL_ID}/inboxEvents/${messageId}`;
}

async function flush() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
}

describe('channelInbox', () => {
    beforeEach(() => {
        mockDb.current = createFakeFirestore();
        ownsBroadcaster.mockReturnValue(true);
    });

    afterEach(() => {
        stopAllInboxes();
    });

    test('forwarding stores the raw payload keyed by EventSub message ID', async () => {
        await forwardToInbox(CHANNEL_ID, {
            messageId: 'msg-1',
            payload: JSON.stringify(chatNotification),
            isChat: true,
            targetOwner: 'instance-a',
        });

        const doc = mockDb.current._read(inboxPath('msg-1'));
        expect(JSON.parse(doc.payload)).toEqual(chatNotification);
        expect(doc).toMatchObject({ isChat: true, targetOwner: 'instance-a', fromInstance: 'instance-b' });
        expect(doc.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    test('the owner processes forwarded events, including ones queued before it started listening', async () => {
        const handler = jest.fn(async () => {});
        await forwardToInbox(CHANNEL_ID, { messageId: 'early', payload: JSON.stringify(chatNotification), isChat: true });

        startInbox(CHANNEL_ID, handler);
        await flush();
        await forwardToInbox(CHANNEL_ID, { messageId: 'later', payload: JSON.stringify(chatNotification), isChat: true });
        await flush();

        expect(handler.mock.calls.map(c => c[1])).toEqual(['early', 'later']);
        expect(handler).toHaveBeenCalledWith(chatNotification, 'early');
        // Claimed events are deleted.
        expect(mockDb.current._read(inboxPath('early'))).toBeUndefined();
        expect(mockDb.current._read(inboxPath('later'))).toBeUndefined();
    });

    test('an event is processed once even if two listeners see it during a handover', async () => {
        const handler = jest.fn(async () => {});
        await forwardToInbox(CHANNEL_ID, { messageId: 'msg-1', payload: JSON.stringify(chatNotification), isChat: true });
        const ref = mockDb.current.collection('channelInbox').doc(CHANNEL_ID).collection('inboxEvents').doc('msg-1');

        await Promise.all([_consume(CHANNEL_ID, ref, handler), _consume(CHANNEL_ID, ref, handler)]);
        await flush();

        expect(handler).toHaveBeenCalledTimes(1);
    });

    test('a non-owner leaves the event for the current owner', async () => {
        ownsBroadcaster.mockReturnValue(false);
        const handler = jest.fn();
        await forwardToInbox(CHANNEL_ID, { messageId: 'msg-1', payload: JSON.stringify(chatNotification), isChat: true });
        const ref = mockDb.current.collection('channelInbox').doc(CHANNEL_ID).collection('inboxEvents').doc('msg-1');

        await _consume(CHANNEL_ID, ref, handler);

        expect(handler).not.toHaveBeenCalled();
        expect(mockDb.current._read(inboxPath('msg-1'))).toBeDefined();
    });

    test('stale chat is dropped rather than answered late', async () => {
        const handler = jest.fn();
        mockDb.current._seed(inboxPath('old'), {
            payload: JSON.stringify(chatNotification),
            isChat: true,
            enqueuedAt: new Date(Date.now() - MAX_CHAT_AGE_MS - 1000),
        });
        const ref = mockDb.current.collection('channelInbox').doc(CHANNEL_ID).collection('inboxEvents').doc('old');

        await _consume(CHANNEL_ID, ref, handler);

        expect(handler).not.toHaveBeenCalled();
        expect(mockDb.current._read(inboxPath('old'))).toBeUndefined();
    });

    test('non-chat events tolerate the same delay', async () => {
        const handler = jest.fn(async () => {});
        mockDb.current._seed(inboxPath('offline'), {
            payload: JSON.stringify({ subscription: { type: 'stream.offline' }, event: {} }),
            isChat: false,
            enqueuedAt: new Date(Date.now() - MAX_CHAT_AGE_MS - 1000),
        });
        const ref = mockDb.current.collection('channelInbox').doc(CHANNEL_ID).collection('inboxEvents').doc('offline');

        await _consume(CHANNEL_ID, ref, handler);
        await flush();

        expect(handler).toHaveBeenCalledTimes(1);
    });

    test('a slow handler does not hold up the next event', async () => {
        let release;
        const slow = new Promise(resolve => { release = resolve; });
        const seen = [];
        const handler = jest.fn(async (_n, id) => {
            seen.push(id);
            if (id === 'slow') await slow;
        });

        startInbox(CHANNEL_ID, handler);
        await forwardToInbox(CHANNEL_ID, { messageId: 'slow', payload: JSON.stringify(chatNotification), isChat: true });
        await flush();
        await forwardToInbox(CHANNEL_ID, { messageId: 'fast', payload: JSON.stringify(chatNotification), isChat: true });
        await flush();

        expect(seen).toEqual(['slow', 'fast']);
        release();
    });

    test('a listener killed by a stream error is restarted while the channel is still owned', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
        try {
            const handler = jest.fn(async () => {});
            startInbox(CHANNEL_ID, handler);
            await flush();

            mockDb.current._failListeners(Object.assign(new Error('PERMISSION_DENIED'), { code: 7 }));
            await forwardToInbox(CHANNEL_ID, { messageId: 'while-down', payload: JSON.stringify(chatNotification), isChat: true });
            await flush();
            expect(handler).not.toHaveBeenCalled();

            await jest.advanceTimersByTimeAsync(5000);
            await flush();

            expect(handler).toHaveBeenCalledWith(chatNotification, 'while-down');
        } finally {
            jest.useRealTimers();
        }
    });

    test('a dead listener is not restarted once the channel has moved on', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
        try {
            const handler = jest.fn(async () => {});
            startInbox(CHANNEL_ID, handler);
            await flush();

            mockDb.current._failListeners(new Error('PERMISSION_DENIED'));
            ownsBroadcaster.mockReturnValue(false);
            await jest.advanceTimersByTimeAsync(5000);

            expect(_getInboxes().has(CHANNEL_ID)).toBe(false);
        } finally {
            jest.useRealTimers();
        }
    });

    test('stopping during the restart delay cancels the restart', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
        try {
            startInbox(CHANNEL_ID, jest.fn());
            await flush();
            mockDb.current._failListeners(new Error('UNAVAILABLE'));

            stopAllInboxes();
            await jest.advanceTimersByTimeAsync(5000);

            expect(_getInboxes().has(CHANNEL_ID)).toBe(false);
        } finally {
            jest.useRealTimers();
        }
    });

    test('stopInbox stops delivery', async () => {
        const handler = jest.fn(async () => {});
        startInbox(CHANNEL_ID, handler);
        await flush();
        stopInbox(CHANNEL_ID);

        await forwardToInbox(CHANNEL_ID, { messageId: 'after-stop', payload: JSON.stringify(chatNotification), isChat: true });
        await flush();

        expect(handler).not.toHaveBeenCalled();
    });
});
