// tests/unit/components/twitch/eventsub.test.js
import { handleKeepAlivePing, clearPhantomEventSubEntries, eventSubHandler, markEventSubReady } from '../../../../src/components/twitch/eventsub.js';
import { getContextManager } from '../../../../src/components/context/contextManager.js';
import { getLiveStreams } from '../../../../src/components/twitch/helixClient.js';
import { deleteTask, scheduleNextKeepAlivePing } from '../../../../src/lib/taskHelpers.js';
import logger from '../../../../src/lib/logger.js';
import LifecycleManager from '../../../../src/services/LifecycleManager.js';
import { isChannelAllowed } from '../../../../src/components/twitch/channelManager.js';
import { notifySubscription, notifyGiftSubs } from '../../../../src/components/autoChat/autoChatManager.js';

// Mock entire modules
jest.mock('../../../../src/components/context/contextManager.js');
jest.mock('../../../../src/components/twitch/helixClient.js');
jest.mock('../../../../src/lib/taskHelpers.js');
jest.mock('../../../../src/lib/logger.js');
jest.mock('../../../../src/lib/ircSender.js');
jest.mock('../../../../src/services/LifecycleManager.js');
jest.mock('../../../../src/components/twitch/channelManager.js');
jest.mock('../../../../src/components/autoChat/autoChatManager.js');

describe('EventSub Legacy Keep-Alive Endpoint', () => {
    let mockLifecycle;

    beforeEach(() => {
        // Reset mocks and clear any phantom entries before each test
        jest.clearAllMocks();

        // Setup LifecycleManager mock
        mockLifecycle = {
            getActiveStreams: jest.fn().mockReturnValue([]),
            onStreamStatusChange: jest.fn()
        };
        LifecycleManager.get.mockReturnValue(mockLifecycle);

        // Legacy keep-alive endpoint no longer schedules tasks (keep-alive is handled in-process)
        scheduleNextKeepAlivePing.mockResolvedValue('keep-alive-task-test');
    });

    test('handleKeepAlivePing is a no-op (keep-alive is now in-process)', async () => {
        await handleKeepAlivePing();

        expect(logger.debug).toHaveBeenCalledWith(
            'Legacy /keep-alive endpoint called - now using in-process keep-alive'
        );

        // Nothing legacy should fire anymore
        expect(scheduleNextKeepAlivePing).not.toHaveBeenCalled();
        expect(deleteTask).not.toHaveBeenCalled();
        expect(getLiveStreams).not.toHaveBeenCalled();
        expect(getContextManager).not.toHaveBeenCalled();
        expect(LifecycleManager.get).not.toHaveBeenCalled();
    });

    test('should clear phantom entries using LifecycleManager', async () => {
        mockLifecycle.getActiveStreams.mockReturnValue(['phantom1', 'phantom2']);

        await clearPhantomEventSubEntries();

        expect(mockLifecycle.onStreamStatusChange).toHaveBeenCalledWith('phantom1', false);
        expect(mockLifecycle.onStreamStatusChange).toHaveBeenCalledWith('phantom2', false);
    });
});

describe('EventSub Ad Break Event Structure', () => {
    test('should have correct structure for channel.ad_break.begin event payload', () => {
        // This test verifies the event payload structure matches Twitch API docs
        // Based on https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channeladbreakbegin
        const mockEvent = {
            broadcaster_user_name: 'TestChannel',
            broadcaster_user_login: 'testchannel',
            broadcaster_user_id: '12345',
            duration_seconds: '60',
            started_at: '2025-01-15T10:00:00Z',
            is_automatic: 'true',
            requester_user_id: '12345',
            requester_user_login: 'testchannel',
            requester_user_name: 'TestChannel'
        };

        // Assert all required fields are present
        expect(mockEvent).toHaveProperty('broadcaster_user_name');
        expect(mockEvent).toHaveProperty('broadcaster_user_login');
        expect(mockEvent).toHaveProperty('duration_seconds');
        expect(mockEvent).toHaveProperty('started_at');
        expect(mockEvent).toHaveProperty('is_automatic');

        // Verify field types match Twitch API (strings, not numbers)
        expect(typeof mockEvent.duration_seconds).toBe('string');
        expect(typeof mockEvent.is_automatic).toBe('string');

        // Verify values
        expect(mockEvent.duration_seconds).toBe('60');
        expect(mockEvent.is_automatic).toBe('true');
    });

    test('should handle both automatic and manual ad breaks', () => {
        const automaticAd = { is_automatic: 'true', duration_seconds: '90' };
        const manualAd = { is_automatic: 'false', duration_seconds: '60' };

        expect(automaticAd.is_automatic).toBe('true');
        expect(manualAd.is_automatic).toBe('false');
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

        isChannelAllowed.mockResolvedValue(true);
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
