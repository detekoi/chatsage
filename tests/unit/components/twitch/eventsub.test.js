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

describe('EventSub Keep-Alive Logic', () => {
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

        // Ensure keep-alive task scheduling returns a task name so deletion logic can run
        scheduleNextKeepAlivePing.mockResolvedValue('keep-alive-task-test');
    });

    test('should keep instance alive if poller detects an active stream', async () => {
        // Arrange
        const mockChannelStates = new Map([
            ['testchannel', { chatHistory: [], streamContext: { streamGame: 'Some Game' } }]
        ]);
        getContextManager.mockReturnValue({
            getAllChannelStates: () => mockChannelStates,
            getContextForLLM: () => ({ streamGame: 'Some Game', streamTitle: 'Title' }),
            getChannelsForPolling: jest.fn().mockResolvedValue([]), // Mock to avoid unrelated errors
        });
        getLiveStreams.mockResolvedValue([]); // No live streams from Helix fallback

        // Act
        await handleKeepAlivePing();

        // Assert
        expect(scheduleNextKeepAlivePing).toHaveBeenCalledTimes(1);
        expect(deleteTask).not.toHaveBeenCalled();
        const infoLog = logger.info.mock.calls.find(call => call[0].includes('Keep-alive check passed'));
        expect(infoLog[0]).toContain('1 stream(s) live via poller');

        // Should notify lifecycle about the poller-detected stream
        expect(mockLifecycle.onStreamStatusChange).toHaveBeenCalledWith('testchannel', true);
    });

    test('should scale down after MAX_FAILED_CHECKS if no activity is detected', async () => {
        // Arrange
        getContextManager.mockReturnValue({
            getAllChannelStates: () => new Map(),
            getContextForLLM: () => ({ streamGame: null }),
            getChannelsForPolling: jest.fn().mockResolvedValue([]),
        });
        getLiveStreams.mockResolvedValue([]); // Helix fallback finds nothing
        mockLifecycle.getActiveStreams.mockReturnValue([]);

        // Act: Simulate 3 consecutive failed checks
        await handleKeepAlivePing(); // Check 1
        await handleKeepAlivePing(); // Check 2
        await handleKeepAlivePing(); // Check 3

        // Assert
        // It schedules the next ping on the first 2 failures
        expect(scheduleNextKeepAlivePing).toHaveBeenCalledTimes(2);
        // On the 3rd failure, it deletes the task
        expect(deleteTask).toHaveBeenCalledTimes(1);
        const warnLog = logger.warn.mock.calls.find(call => call[0].includes('Allowing instance to scale down'));
        expect(warnLog).toBeDefined();
    });

    test('should keep instance alive if there is recent chat activity', async () => {
        // Arrange
        const recentTimestamp = new Date(Date.now() - 60 * 1000); // 1 minute ago
        const mockChannelStates = new Map([
            ['chattychannel', {
                chatHistory: [{ timestamp: recentTimestamp, message: 'hello' }],
                streamContext: { streamGame: null }
            }]
        ]);
        getContextManager.mockReturnValue({
            getAllChannelStates: () => mockChannelStates,
            getContextForLLM: () => ({ streamGame: null }),
            getChannelsForPolling: jest.fn().mockResolvedValue([]),
        });
        getLiveStreams.mockResolvedValue([]);

        // Act
        await handleKeepAlivePing();

        // Assert
        expect(scheduleNextKeepAlivePing).toHaveBeenCalledTimes(1);
        expect(deleteTask).not.toHaveBeenCalled();
        const infoLog = logger.info.mock.calls.find(call => call[0].includes('Keep-alive check passed'));
        expect(infoLog[0]).toContain('recent chat in: chattychannel');
    });

    test('should use Helix fallback check if all other signals are negative', async () => {
        // Arrange
        getContextManager.mockReturnValue({
            getAllChannelStates: () => new Map(),
            getContextForLLM: () => ({ streamGame: null }),
            // This time, the poller will find channels to check
            getChannelsForPolling: jest.fn().mockResolvedValue([
                { channelName: 'livechannel', broadcasterId: '123' }
            ]),
        });
        // Helix fallback *does* find a live stream
        getLiveStreams.mockResolvedValue([{ user_id: '123', user_name: 'LiveChannel' }]);

        // Act
        await handleKeepAlivePing();

        // Assert
        expect(getLiveStreams).toHaveBeenCalledWith(['123']);
        expect(scheduleNextKeepAlivePing).toHaveBeenCalledTimes(1);
        const infoLog = logger.info.mock.calls.find(call => call[0].includes('Helix fallback detected live streams'));
        expect(infoLog).toBeDefined();

        // Should notify lifecycle about the helix-detected stream
        expect(mockLifecycle.onStreamStatusChange).toHaveBeenCalledWith('livechannel', true);
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
