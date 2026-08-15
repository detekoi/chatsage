// tests/unit/components/twitch/eventsub.test.js
import { clearPhantomEventSubEntries, eventSubHandler, markEventSubReady } from '../../../../src/components/twitch/eventsub.js';
import LifecycleManager from '../../../../src/services/LifecycleManager.js';
import { isChannelActive } from '../../../../src/components/twitch/channelManager.js';
import { notifySubscription, notifyGiftSubs, notifyAdBreak } from '../../../../src/components/autoChat/autoChatManager.js';

// Mock entire modules
jest.mock('../../../../src/components/context/contextManager.js');
jest.mock('../../../../src/components/twitch/helixClient.js');
jest.mock('../../../../src/lib/logger.js');
jest.mock('../../../../src/lib/ircSender.js');
jest.mock('../../../../src/services/LifecycleManager.js');
jest.mock('../../../../src/components/twitch/channelManager.js');
jest.mock('../../../../src/components/autoChat/autoChatManager.js');

describe('EventSub Phantom Entry Cleanup', () => {
    let mockLifecycle;

    beforeEach(() => {
        jest.clearAllMocks();
        mockLifecycle = {
            getActiveStreams: jest.fn().mockReturnValue([]),
            onStreamStatusChange: jest.fn()
        };
        LifecycleManager.get.mockReturnValue(mockLifecycle);
    });

    test('should clear phantom entries using LifecycleManager', async () => {
        mockLifecycle.getActiveStreams.mockReturnValue(['phantom1', 'phantom2']);

        await clearPhantomEventSubEntries();

        expect(mockLifecycle.onStreamStatusChange).toHaveBeenCalledWith('phantom1', false);
        expect(mockLifecycle.onStreamStatusChange).toHaveBeenCalledWith('phantom2', false);
    });
});

describe('EventSub Ad Break Routing', () => {
    // The docs type is_automatic and duration_seconds as strings
    // (https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channeladbreakbegin)
    // but observed webhook deliveries carry a real boolean and a real number.
    // Both shapes are exercised here because the handler has to survive either.
    let mockRes;
    let oldBypass;

    const adBreakBody = (event) => JSON.stringify({
        subscription: { type: 'channel.ad_break.begin' },
        event: {
            broadcaster_user_name: 'TestChannel',
            broadcaster_user_login: 'testchannel',
            broadcaster_user_id: '12345',
            started_at: '2025-01-15T10:00:00Z',
            requester_user_login: 'testchannel',
            ...event
        }
    });

    const adBreakReq = (id) => ({
        headers: {
            'twitch-eventsub-message-type': 'notification',
            'twitch-eventsub-message-id': id,
            'twitch-eventsub-message-timestamp': new Date().toISOString()
        }
    });

    beforeEach(() => {
        jest.clearAllMocks();
        oldBypass = process.env.EVENTSUB_BYPASS;
        process.env.EVENTSUB_BYPASS = 'true';
        markEventSubReady();

        mockRes = {
            writeHead: jest.fn().mockReturnThis(),
            end: jest.fn().mockReturnThis()
        };

        isChannelActive.mockResolvedValue(true);
    });

    afterEach(() => {
        if (oldBypass === undefined) {
            delete process.env.EVENTSUB_BYPASS;
        } else {
            process.env.EVENTSUB_BYPASS = oldBypass;
        }
    });

    test.each([
        ['boolean payload (as delivered)', false, 60],
        ['string payload (as documented)', 'false', '60']
    ])('announces a manually started ad break — %s', async (_label, isAutomatic, durationSeconds) => {
        const rawBody = adBreakBody({ is_automatic: isAutomatic, duration_seconds: durationSeconds });

        await eventSubHandler(adBreakReq(`ad-manual-${_label}`), mockRes, rawBody);

        expect(notifyAdBreak).toHaveBeenCalledTimes(1);
        expect(notifyAdBreak).toHaveBeenCalledWith('testchannel', expect.objectContaining({
            is_automatic: isAutomatic
        }));
    });

    test.each([
        ['boolean payload (as delivered)', true, 120],
        ['string payload (as documented)', 'true', '90']
    ])('stays silent on a scheduled ad break, which the poller already warned about — %s', async (_label, isAutomatic, durationSeconds) => {
        const rawBody = adBreakBody({ is_automatic: isAutomatic, duration_seconds: durationSeconds });

        await eventSubHandler(adBreakReq(`ad-auto-${_label}`), mockRes, rawBody);

        expect(notifyAdBreak).not.toHaveBeenCalled();
    });
});

describe('EventSub Revocation', () => {
    test('acknowledges a revocation message without processing it as a notification', async () => {
        const mockRes = {
            writeHead: jest.fn().mockReturnThis(),
            end: jest.fn().mockReturnThis()
        };
        const req = {
            headers: {
                'twitch-eventsub-message-type': 'revocation',
                'twitch-eventsub-message-id': 'revoke-msg-1',
                'twitch-eventsub-message-timestamp': new Date().toISOString()
            }
        };
        const rawBody = JSON.stringify({
            subscription: {
                type: 'channel.ad_break.begin',
                status: 'authorization_revoked',
                condition: { broadcaster_user_id: '12345' }
            }
        });

        const oldBypass = process.env.EVENTSUB_BYPASS;
        process.env.EVENTSUB_BYPASS = 'true';
        try {
            await eventSubHandler(req, mockRes, rawBody);
        } finally {
            if (oldBypass === undefined) delete process.env.EVENTSUB_BYPASS;
            else process.env.EVENTSUB_BYPASS = oldBypass;
        }

        expect(mockRes.writeHead).toHaveBeenCalledWith(200);
        expect(notifyAdBreak).not.toHaveBeenCalled();
    });
});

describe('EventSub Webhook Routing & Subscription Celebrations', () => {
    let mockRes;
    let oldBypass;

    beforeEach(() => {
        oldBypass = process.env.EVENTSUB_BYPASS;
        process.env.EVENTSUB_BYPASS = 'true';
        markEventSubReady();

        mockRes = {
            writeHead: jest.fn().mockReturnThis(),
            end: jest.fn().mockReturnThis()
        };

        isChannelActive.mockResolvedValue(true);
    });

    afterEach(() => {
        if (oldBypass === undefined) {
            delete process.env.EVENTSUB_BYPASS;
        } else {
            process.env.EVENTSUB_BYPASS = oldBypass;
        }
    });

    test('should process standard sub event and trigger notifySubscription', async () => {
        const req = {
            headers: {
                'twitch-eventsub-message-type': 'notification',
                'twitch-eventsub-message-id': 'sub-msg-1',
                'twitch-eventsub-message-timestamp': new Date().toISOString()
            }
        };

        const rawBody = JSON.stringify({
            subscription: {
                type: 'channel.subscribe'
            },
            event: {
                broadcaster_user_name: 'testchannel',
                broadcaster_user_id: '12345',
                is_gift: false
            }
        });

        await eventSubHandler(req, mockRes, rawBody);

        expect(mockRes.writeHead).toHaveBeenCalledWith(200);
        expect(notifySubscription).toHaveBeenCalledWith('testchannel');
        expect(notifyGiftSubs).not.toHaveBeenCalled();
    });

    test('should skip standard sub event when it is a gift (guarded by is_gift: true)', async () => {
        const req = {
            headers: {
                'twitch-eventsub-message-type': 'notification',
                'twitch-eventsub-message-id': 'sub-msg-2',
                'twitch-eventsub-message-timestamp': new Date().toISOString()
            }
        };

        const rawBody = JSON.stringify({
            subscription: {
                type: 'channel.subscribe'
            },
            event: {
                broadcaster_user_name: 'testchannel',
                broadcaster_user_id: '12345',
                is_gift: true
            }
        });

        await eventSubHandler(req, mockRes, rawBody);

        expect(mockRes.writeHead).toHaveBeenCalledWith(200);
        expect(notifySubscription).not.toHaveBeenCalled();
        expect(notifyGiftSubs).not.toHaveBeenCalled();
    });

    test('should route channel.subscription.gift events to notifyGiftSubs', async () => {
        const req = {
            headers: {
                'twitch-eventsub-message-type': 'notification',
                'twitch-eventsub-message-id': 'sub-msg-3',
                'twitch-eventsub-message-timestamp': new Date().toISOString()
            }
        };

        const rawBody = JSON.stringify({
            subscription: {
                type: 'channel.subscription.gift'
            },
            event: {
                broadcaster_user_name: 'testchannel',
                broadcaster_user_id: '12345',
                total: 5,
                is_anonymous: false,
                user_name: 'GifterGuy',
                cumulative_total: 10
            }
        });

        await eventSubHandler(req, mockRes, rawBody);

        expect(mockRes.writeHead).toHaveBeenCalledWith(200);
        expect(notifyGiftSubs).toHaveBeenCalledWith('testchannel', 5, 'GifterGuy', 10);
    });

    test('should handle anonymous users correctly in channel.subscription.gift', async () => {
        const req = {
            headers: {
                'twitch-eventsub-message-type': 'notification',
                'twitch-eventsub-message-id': 'sub-msg-4',
                'twitch-eventsub-message-timestamp': new Date().toISOString()
            }
        };

        const rawBody = JSON.stringify({
            subscription: {
                type: 'channel.subscription.gift'
            },
            event: {
                broadcaster_user_name: 'testchannel',
                broadcaster_user_id: '12345',
                total: 3,
                is_anonymous: true,
                cumulative_total: null
            }
        });

        await eventSubHandler(req, mockRes, rawBody);

        expect(mockRes.writeHead).toHaveBeenCalledWith(200);
        expect(notifyGiftSubs).toHaveBeenCalledWith('testchannel', 3, null, null);
    });
});
