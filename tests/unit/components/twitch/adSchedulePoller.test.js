// tests/unit/components/twitch/adSchedulePoller.test.js
import { startAdSchedulePoller, stopAdSchedulePoller } from '../../../../src/components/twitch/adSchedulePoller.js';
import { getContextManager } from '../../../../src/components/context/contextManager.js';
import { getChannelAutoChatConfig } from '../../../../src/components/context/autoChatStorage.js';
import { notifyAdSoon } from '../../../../src/components/autoChat/autoChatManager.js';
import axios from 'axios';
import logger from '../../../../src/lib/logger.js';

jest.mock('../../../../src/components/context/contextManager.js');
jest.mock('../../../../src/components/context/autoChatStorage.js');
jest.mock('../../../../src/components/autoChat/autoChatManager.js');
jest.mock('axios');
jest.mock('../../../../src/lib/logger.js');
jest.mock('../../../../src/lib/secretManager.js', () => ({
    getSecretValue: jest.fn().mockResolvedValue('mock-token'),
    initializeSecretManager: jest.fn(),
}));

describe('Ad Schedule Poller', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
        stopAdSchedulePoller(); // Clean up any existing intervals

        // Default mocks
        process.env.WEBUI_BASE_URL = 'https://mock-webui.example.com';
        process.env.WEBUI_INTERNAL_TOKEN = 'mock-token-value';
    });

    afterEach(() => {
        stopAdSchedulePoller();
        jest.useRealTimers();
        delete process.env.WEBUI_BASE_URL;
        delete process.env.WEBUI_INTERNAL_TOKEN;
    });

    test('should poll for ad schedules when stream is live and ads enabled', async () => {
        // Arrange
        const nextAdTime = new Date(Date.now() + 120_000); // 2 minutes from now
        const mockChannelStates = new Map([
            ['testchannel', {
                streamContext: { game: 'Test Game', title: 'Test Stream' }
            }]
        ]);

        getContextManager.mockReturnValue({
            getAllChannelStates: () => mockChannelStates,
        });

        getChannelAutoChatConfig.mockResolvedValue({
            mode: 'medium',
            categories: { ads: true }
        });

        axios.get.mockResolvedValue({
            data: {
                success: true,
                data: {
                    data: [{
                        snooze_count: 2,
                        next_ad_at: nextAdTime.toISOString(),
                        duration: 90,
                        last_ad_at: new Date(Date.now() - 600_000).toISOString(),
                        preroll_free_time: 0
                    }]
                }
            }
        });

        // Act
        startAdSchedulePoller();
        await jest.advanceTimersByTimeAsync(30_000); // Trigger first poll

        // Assert - Verify API called with correct parameters
        expect(axios.get).toHaveBeenCalledWith(
            expect.stringContaining('/internal/ads/schedule'),
            expect.objectContaining({
                params: { channel: 'testchannel' },
                headers: { Authorization: 'Bearer mock-token' } // From mocked getSecretValue
            })
        );

        // Verify ad schedule data was parsed successfully
        // We check this by verifying no errors occurred
        expect(logger.error).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
    });

    test('should skip polling when stream is offline', async () => {
        // Arrange
        const mockChannelStates = new Map([
            ['offlinechannel', {
                streamContext: { game: null }
            }]
        ]);

        getContextManager.mockReturnValue({
            getAllChannelStates: () => mockChannelStates,
        });

        // Act
        startAdSchedulePoller();
        await jest.advanceTimersByTimeAsync(30_000);

        // Assert
        expect(axios.get).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith(
            expect.objectContaining({ channelName: 'offlinechannel' }),
            '[AdSchedule] Skipping - stream offline'
        );
    });

    test('should skip polling when ads category is disabled', async () => {
        // Arrange
        const mockChannelStates = new Map([
            ['testchannel', {
                streamContext: { game: 'Test Game' }
            }]
        ]);

        getContextManager.mockReturnValue({
            getAllChannelStates: () => mockChannelStates,
        });

        getChannelAutoChatConfig.mockResolvedValue({
            mode: 'medium',
            categories: { ads: false } // Ads disabled
        });

        // Act
        startAdSchedulePoller();
        await jest.advanceTimersByTimeAsync(30_000);

        // Assert
        expect(axios.get).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith(
            expect.objectContaining({ channelName: 'testchannel' }),
            '[AdSchedule] Skipping - ads disabled'
        );
    });

    test('should handle Unix timestamp format for next_ad_at', async () => {
        // Arrange
        const nextAdTimestamp = Math.floor(Date.now() / 1000) + 120; // 2 min from now
        const mockChannelStates = new Map([
            ['testchannel', { streamContext: { game: 'Test Game' } }]
        ]);

        getContextManager.mockReturnValue({
            getAllChannelStates: () => mockChannelStates,
        });

        getChannelAutoChatConfig.mockResolvedValue({
            mode: 'medium',
            categories: { ads: true }
        });

        axios.get.mockResolvedValue({
            data: {
                success: true,
                data: {
                    data: [{
                        snooze_count: 1,
                        next_ad_at: nextAdTimestamp,
                        duration: 60,
                    }]
                }
            }
        });

        // Act
        startAdSchedulePoller();
        await jest.advanceTimersByTimeAsync(30_000);

        // Assert - Verify Unix timestamp was parsed correctly by checking API was called
        expect(axios.get).toHaveBeenCalled();
        // Verify no errors were logged (which would indicate timestamp parsing failed)
        expect(logger.error).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
    });

    test('should handle authentication errors with helpful message', async () => {
        // Arrange
        const mockChannelStates = new Map([
            ['testchannel', { streamContext: { game: 'Test Game' } }]
        ]);

        getContextManager.mockReturnValue({
            getAllChannelStates: () => mockChannelStates,
        });

        getChannelAutoChatConfig.mockResolvedValue({
            mode: 'medium',
            categories: { ads: true }
        });

        axios.get.mockRejectedValue({
            response: {
                status: 403,
                data: { message: 'Missing required scope: channel:read:ads' }
            }
        });

        // Act
        startAdSchedulePoller();
        await jest.advanceTimersByTimeAsync(30_000);

        // Assert
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                channelName: 'testchannel',
                status: 403
            }),
            expect.stringContaining('AUTHENTICATION REQUIRED')
        );
    });

    test('should handle empty ad schedule response', async () => {
        // Arrange
        const mockChannelStates = new Map([
            ['testchannel', { streamContext: { game: 'Test Game' } }]
        ]);

        getContextManager.mockReturnValue({
            getAllChannelStates: () => mockChannelStates,
        });

        getChannelAutoChatConfig.mockResolvedValue({
            mode: 'medium',
            categories: { ads: true }
        });

        // API returns empty array (no scheduled ads)
        axios.get.mockResolvedValue({
            data: {
                success: true,
                data: { data: [] }
            }
        });

        // Act
        startAdSchedulePoller();
        await jest.advanceTimersByTimeAsync(30_000);

        // Assert - Verify API was called and no notification was scheduled
        expect(axios.get).toHaveBeenCalled();
        expect(notifyAdSoon).not.toHaveBeenCalled();
        // No errors should be logged
        expect(logger.error).not.toHaveBeenCalled();
    });

    test('should not schedule notification for ads that already passed', async () => {
        // Arrange
        const pastAdTime = new Date(Date.now() - 30_000); // 30 seconds ago
        const mockChannelStates = new Map([
            ['testchannel', { streamContext: { game: 'Test Game' } }]
        ]);

        getContextManager.mockReturnValue({
            getAllChannelStates: () => mockChannelStates,
        });

        getChannelAutoChatConfig.mockResolvedValue({
            mode: 'medium',
            categories: { ads: true }
        });

        axios.get.mockResolvedValue({
            data: {
                success: true,
                data: {
                    data: [{
                        next_ad_at: pastAdTime.toISOString(),
                        duration: 60,
                    }]
                }
            }
        });

        // Act
        startAdSchedulePoller();
        await jest.advanceTimersByTimeAsync(30_000);

        // Assert - Verify notification was not scheduled for past ads
        expect(axios.get).toHaveBeenCalled();
        expect(notifyAdSoon).not.toHaveBeenCalled();
    });

    test('should handle 404 error for channels not in database', async () => {
        // Arrange
        const mockChannelStates = new Map([
            ['newchannel', { streamContext: { game: 'Test Game' } }]
        ]);

        getContextManager.mockReturnValue({
            getAllChannelStates: () => mockChannelStates,
        });

        getChannelAutoChatConfig.mockResolvedValue({
            mode: 'medium',
            categories: { ads: true }
        });

        axios.get.mockRejectedValue({
            response: {
                status: 404,
                data: { message: 'User not found' }
            },
            message: 'Request failed with status code 404'
        });

        // Act
        startAdSchedulePoller();
        await jest.advanceTimersByTimeAsync(30_000);

        // Assert - Verify error is logged (falls through to generic error handler)
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                channelName: 'newchannel',
                status: 404
            }),
            expect.stringContaining('[AdSchedule] Failed to fetch ad schedule')
        );
    });

    test('should poll multiple channels independently', async () => {
        // Arrange
        const nextAdTime1 = new Date(Date.now() + 120_000);
        const nextAdTime2 = new Date(Date.now() + 180_000);

        const mockChannelStates = new Map([
            ['channel1', { streamContext: { game: 'Game 1' } }],
            ['channel2', { streamContext: { game: 'Game 2' } }]
        ]);

        getContextManager.mockReturnValue({
            getAllChannelStates: () => mockChannelStates,
        });

        getChannelAutoChatConfig.mockResolvedValue({
            mode: 'medium',
            categories: { ads: true }
        });

        axios.get
            .mockResolvedValueOnce({
                data: {
                    success: true,
                    data: { data: [{ next_ad_at: nextAdTime1.toISOString(), duration: 60 }] }
                }
            })
            .mockResolvedValueOnce({
                data: {
                    success: true,
                    data: { data: [{ next_ad_at: nextAdTime2.toISOString(), duration: 90 }] }
                }
            });

        // Act
        startAdSchedulePoller();
        await jest.advanceTimersByTimeAsync(30_000);

        // Assert
        expect(axios.get).toHaveBeenCalledTimes(2);
        expect(axios.get).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ params: { channel: 'channel1' } })
        );
        expect(axios.get).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ params: { channel: 'channel2' } })
        );
    });

    test('should not send duplicate notifications for the same ad', async () => {
        // Arrange
        const nextAdTime = new Date(Date.now() + 120_000); // 2 minutes from now
        const mockChannelStates = new Map([
            ['testchannel', { streamContext: { game: 'Test Game' } }]
        ]);

        getContextManager.mockReturnValue({
            getAllChannelStates: () => mockChannelStates,
        });

        getChannelAutoChatConfig.mockResolvedValue({
            mode: 'medium',
            categories: { ads: true }
        });

        // Return the same ad time on multiple polls
        axios.get.mockResolvedValue({
            data: {
                success: true,
                data: {
                    data: [{
                        next_ad_at: nextAdTime.toISOString(),
                        duration: 60,
                    }]
                }
            }
        });

        // Act - Run multiple poll cycles
        startAdSchedulePoller();
        await jest.advanceTimersByTimeAsync(30_000); // First poll
        await jest.advanceTimersByTimeAsync(30_000); // Second poll (same ad)
        await jest.advanceTimersByTimeAsync(30_000); // Third poll (same ad)

        // Assert - Should only schedule notification once
        expect(logger.info).toHaveBeenCalledWith(
            expect.objectContaining({ channelName: 'testchannel' }),
            '[AdSchedule] 🔔 Ad notification scheduled'
        );

        // Verify subsequent polls logged "already notified" debug message
        expect(logger.debug).toHaveBeenCalledWith(
            expect.objectContaining({ channelName: 'testchannel' }),
            '[AdSchedule] Already notified about this ad - skipping'
        );
    });

    // Note: Testing missing config requires mocking the config module,
    // which is complex due to how the config loader works.
    // The defensive check in adSchedulePoller.js prevents crashes if config is missing.
});