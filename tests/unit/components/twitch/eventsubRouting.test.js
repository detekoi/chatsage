// tests/unit/components/twitch/eventsubRouting.test.js
// A webhook for a channel this instance does not own is handed to the owner
// through the channel inbox instead of being processed here.
import { eventSubHandler, handleForwardedNotification, markEventSubReady } from '../../../../src/components/twitch/eventsub.js';
import LifecycleManager from '../../../../src/services/LifecycleManager.js';
import { isChannelActive } from '../../../../src/components/twitch/channelManager.js';
import { notifyRaid } from '../../../../src/components/autoChat/autoChatManager.js';
import { handleChatMessage } from '../../../../src/handlers/chatMessageHandler.js';
import {
    isOwnershipEnabled,
    ownsBroadcaster,
    claimChannel,
    touchBroadcaster,
} from '../../../../src/lib/channelOwnership.js';
import { forwardToInbox } from '../../../../src/lib/channelInbox.js';

jest.mock('../../../../src/components/context/contextManager.js');
jest.mock('../../../../src/components/twitch/helixClient.js');
jest.mock('../../../../src/lib/logger.js');
jest.mock('../../../../src/lib/ircSender.js');
jest.mock('../../../../src/services/LifecycleManager.js');
jest.mock('../../../../src/components/twitch/channelManager.js');
jest.mock('../../../../src/components/autoChat/autoChatManager.js');
jest.mock('../../../../src/handlers/chatMessageHandler.js');
jest.mock('../../../../src/lib/channelOwnership.js', () => ({
    isOwnershipEnabled: jest.fn(() => true),
    ownsBroadcaster: jest.fn(() => false),
    claimChannel: jest.fn(),
    touchBroadcaster: jest.fn(),
    whenOwnershipReady: jest.fn(async () => true),
}));
jest.mock('../../../../src/lib/channelInbox.js', () => ({
    forwardToInbox: jest.fn(async () => {}),
}));

let messageCounter = 0;

function chatBody(overrides = {}) {
    return JSON.stringify({
        subscription: { type: 'channel.chat.message' },
        event: {
            broadcaster_user_id: '111',
            broadcaster_user_login: 'parfaitfair',
            broadcaster_user_name: 'ParfaitFair',
            chatter_user_id: '999',
            chatter_user_login: 'viewer',
            chatter_user_name: 'Viewer',
            message_id: 'chat-1',
            message: { text: '!trivia', fragments: [] },
            badges: [],
            ...overrides,
        },
    });
}

function request() {
    messageCounter += 1;
    return {
        headers: {
            'twitch-eventsub-message-type': 'notification',
            'twitch-eventsub-message-id': `msg-${messageCounter}`,
            'twitch-eventsub-message-timestamp': new Date().toISOString(),
        },
    };
}

describe('EventSub channel routing', () => {
    let res;
    let oldBypass;

    beforeEach(() => {
        jest.clearAllMocks();
        oldBypass = process.env.EVENTSUB_BYPASS;
        process.env.EVENTSUB_BYPASS = 'true';
        markEventSubReady();
        res = { writeHead: jest.fn().mockReturnThis(), end: jest.fn().mockReturnThis() };
        LifecycleManager.get.mockReturnValue({ onStreamStatusChange: jest.fn() });
        isChannelActive.mockResolvedValue(true);
        isOwnershipEnabled.mockReturnValue(true);
        ownsBroadcaster.mockReturnValue(false);
    });

    afterEach(() => {
        if (oldBypass === undefined) delete process.env.EVENTSUB_BYPASS;
        else process.env.EVENTSUB_BYPASS = oldBypass;
    });

    test('forwards to the owner when another instance holds the channel', async () => {
        claimChannel.mockResolvedValue({ owned: false, ownerId: 'instance-a' });
        const req = request();
        const body = chatBody();

        await eventSubHandler(req, res, Buffer.from(body));

        expect(res.writeHead).toHaveBeenCalledWith(200);
        expect(forwardToInbox).toHaveBeenCalledWith('111', {
            messageId: req.headers['twitch-eventsub-message-id'],
            payload: body,
            isChat: true,
            targetOwner: 'instance-a',
        });
        expect(handleChatMessage).not.toHaveBeenCalled();
    });

    test('handles locally when it already owns the channel', async () => {
        ownsBroadcaster.mockReturnValue(true);

        await eventSubHandler(request(), res, Buffer.from(chatBody()));

        expect(claimChannel).not.toHaveBeenCalled();
        expect(forwardToInbox).not.toHaveBeenCalled();
        expect(touchBroadcaster).toHaveBeenCalledWith('111');
        expect(handleChatMessage).toHaveBeenCalledWith('#parfaitfair', expect.any(Object), '!trivia');
    });

    test('claims an unowned channel and handles the event itself', async () => {
        claimChannel.mockResolvedValue({ owned: true, ownerId: 'me' });

        await eventSubHandler(request(), res, Buffer.from(chatBody()));

        expect(claimChannel).toHaveBeenCalledWith('111', 'parfaitfair');
        expect(forwardToInbox).not.toHaveBeenCalled();
        expect(handleChatMessage).toHaveBeenCalledTimes(1);
    });

    test('routes a raid by the raided channel', async () => {
        claimChannel.mockResolvedValue({ owned: false, ownerId: 'instance-a' });
        const body = JSON.stringify({
            subscription: { type: 'channel.raid' },
            event: {
                from_broadcaster_user_id: '555',
                from_broadcaster_user_login: 'raider',
                from_broadcaster_user_name: 'Raider',
                to_broadcaster_user_id: '111',
                to_broadcaster_user_login: 'parfaitfair',
                to_broadcaster_user_name: 'ParfaitFair',
                viewers: 12,
            },
        });

        await eventSubHandler(request(), res, Buffer.from(body));

        expect(claimChannel).toHaveBeenCalledWith('111', 'parfaitfair');
        expect(forwardToInbox).toHaveBeenCalledWith('111', expect.objectContaining({ isChat: false }));
        expect(notifyRaid).not.toHaveBeenCalled();
    });

    test('falls back to handling locally when routing fails', async () => {
        claimChannel.mockRejectedValue(new Error('UNAVAILABLE'));

        await eventSubHandler(request(), res, Buffer.from(chatBody()));

        expect(handleChatMessage).toHaveBeenCalledTimes(1);
    });

    test('never leases a channel the bot is not switched on for', async () => {
        isChannelActive.mockResolvedValue(false);

        await eventSubHandler(request(), res, Buffer.from(chatBody()));

        expect(claimChannel).not.toHaveBeenCalled();
        expect(forwardToInbox).not.toHaveBeenCalled();
    });

    test('with ownership disabled everything is handled locally', async () => {
        isOwnershipEnabled.mockReturnValue(false);

        await eventSubHandler(request(), res, Buffer.from(chatBody()));

        expect(claimChannel).not.toHaveBeenCalled();
        expect(handleChatMessage).toHaveBeenCalledTimes(1);
    });

    test('a forwarded chat message is handled once even if Twitch also retried it here', async () => {
        const notification = JSON.parse(chatBody());

        await handleForwardedNotification(notification, 'forwarded-1');
        await handleForwardedNotification(notification, 'forwarded-1');

        expect(handleChatMessage).toHaveBeenCalledTimes(1);
    });
});
