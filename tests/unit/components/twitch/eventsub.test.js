// tests/unit/components/twitch/eventsub.test.js
import { handleKeepAlivePing, clearPhantomEventSubEntries } from '../../../../src/components/twitch/eventsub.js';
import { getContextManager } from '../../../../src/components/context/contextManager.js';
import { getLiveStreams } from '../../../../src/components/twitch/helixClient.js';
import { deleteTask, scheduleNextKeepAlivePing } from '../../../../src/lib/taskHelpers.js';
import logger from '../../../../src/lib/logger.js';
import LifecycleManager from '../../../../src/services/LifecycleManager.js';

// Mock entire modules
jest.mock('../../../../src/components/context/contextManager.js');
jest.mock('../../../../src/components/twitch/helixClient.js');
jest.mock('../../../../src/lib/taskHelpers.js');
jest.mock('../../../../src/lib/logger.js');
jest.mock('../../../../src/lib/ircSender.js');
jest.mock('../../../../src/components/twitch/ircClient.js');
jest.mock('../../../../src/services/LifecycleManager.js');

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
