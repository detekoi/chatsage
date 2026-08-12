// tests/unit/components/twitch/adNotificationTask.test.js
// Covers the scale-to-zero path: the poller enqueues a durable Cloud Task
// instead of an in-process setTimeout, and the delivered task re-validates
// everything before posting.
import {
    handleAdNotificationTask,
    startAdSchedulePoller,
    stopAdSchedulePoller,
} from '../../../../src/components/twitch/adSchedulePoller.js';
import { getContextManager } from '../../../../src/components/context/contextManager.js';
import { getChannelAutoChatConfig } from '../../../../src/components/context/autoChatStorage.js';
import { notifyAdSoon, generateAdNotification } from '../../../../src/components/autoChat/autoChatManager.js';
import { isStreamLive } from '../../../../src/components/context/liveStatus.js';
import { isCloudTasksEnabled, scheduleTask, cancelTask, buildTaskId } from '../../../../src/lib/cloudTasks.js';
import axios from 'axios';

jest.mock('../../../../src/components/context/contextManager.js');
jest.mock('../../../../src/components/context/autoChatStorage.js');
jest.mock('../../../../src/components/autoChat/autoChatManager.js');
jest.mock('../../../../src/components/context/liveStatus.js');
jest.mock('../../../../src/lib/cloudTasks.js');
jest.mock('axios');
jest.mock('../../../../src/lib/logger.js');
jest.mock('../../../../src/lib/secretManager.js', () => ({
    getSecretValue: jest.fn().mockResolvedValue('mock-token'),
    initializeSecretManager: jest.fn(),
}));

const CHANNEL = 'parfaitfair';

describe('ad notification Cloud Task', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        stopAdSchedulePoller();
        // config.webui is captured from the environment when loader.js is imported, so
        // assigning process.env here would not reach it. tests/env.setup.js supplies
        // WEBUI_BASE_URL and WEBUI_INTERNAL_TOKEN before any import runs.

        getChannelAutoChatConfig.mockResolvedValue({ mode: 'off', categories: { ads: true } });
        isStreamLive.mockReturnValue(true);
        generateAdNotification.mockResolvedValue('Ads in a minute, grab a snack');
        notifyAdSoon.mockResolvedValue(undefined);
        isCloudTasksEnabled.mockReturnValue(true);
        scheduleTask.mockResolvedValue({ scheduled: true });
        cancelTask.mockResolvedValue(true);
        // Keep the real id shape so assertions exercise the caller's wiring.
        buildTaskId.mockImplementation((kind, channel, ms) => `${kind}-${channel}-${ms}`);
    });

    afterEach(() => {
        stopAdSchedulePoller();
    });

    describe('handleAdNotificationTask', () => {
        test('rejects a payload missing the ad timestamp', async () => {
            await expect(handleAdNotificationTask({ channelName: CHANNEL }))
                .rejects.toThrow(/missing channelName or adAtMs/);
        });

        test('drops the task when ads have since been disabled', async () => {
            getChannelAutoChatConfig.mockResolvedValue({ mode: 'off', categories: { ads: false } });

            const result = await handleAdNotificationTask({ channelName: CHANNEL, adAtMs: Date.now() + 45_000 });

            expect(result).toEqual({ sent: false, reason: 'ads-disabled' });
            expect(notifyAdSoon).not.toHaveBeenCalled();
        });

        test('drops the task when the stream went offline while it was queued', async () => {
            isStreamLive.mockReturnValue(false);

            const result = await handleAdNotificationTask({ channelName: CHANNEL, adAtMs: Date.now() + 45_000 });

            expect(result).toEqual({ sent: false, reason: 'stream-offline' });
            expect(notifyAdSoon).not.toHaveBeenCalled();
        });

        test('drops the task if it arrives after the ad break already began', async () => {
            const result = await handleAdNotificationTask({ channelName: CHANNEL, adAtMs: Date.now() - 5_000 });

            expect(result).toEqual({ sent: false, reason: 'too-late' });
            expect(notifyAdSoon).not.toHaveBeenCalled();
        });

        test('sends the warning with the real remaining seconds, not a hardcoded 60', async () => {
            // Delivered late enough that no wait is needed: 45s before the ad.
            const result = await handleAdNotificationTask({ channelName: CHANNEL, adAtMs: Date.now() + 45_000 });

            expect(result).toEqual({ sent: true });
            expect(notifyAdSoon).toHaveBeenCalledTimes(1);

            const [channel, seconds, text] = notifyAdSoon.mock.calls[0];
            expect(channel).toBe(CHANNEL);
            expect(seconds).toBeGreaterThan(40);
            expect(seconds).toBeLessThanOrEqual(45);
            expect(text).toBe('Ads in a minute, grab a snack');
        });

        test('still posts when generation fails, letting notifyAdSoon generate live', async () => {
            generateAdNotification.mockRejectedValue(new Error('LLM timeout'));

            const result = await handleAdNotificationTask({ channelName: CHANNEL, adAtMs: Date.now() + 45_000 });

            expect(result).toEqual({ sent: true });
            expect(notifyAdSoon).toHaveBeenCalledWith(CHANNEL, expect.any(Number), null);
        });

        test('generates before waiting so a cold start cannot eat the lead time', async () => {
            jest.useFakeTimers();
            try {
                // 70s out: the warning is due in 10s, so the handler must wait.
                const promise = handleAdNotificationTask({ channelName: CHANNEL, adAtMs: Date.now() + 70_000 });

                await Promise.resolve();
                expect(generateAdNotification).toHaveBeenCalled();
                expect(notifyAdSoon).not.toHaveBeenCalled();

                await jest.advanceTimersByTimeAsync(10_000);
                await promise;

                expect(notifyAdSoon).toHaveBeenCalledTimes(1);
                expect(notifyAdSoon.mock.calls[0][1]).toBeLessThanOrEqual(60);
            } finally {
                jest.useRealTimers();
            }
        });
    });

    describe('poller scheduling', () => {
        function arrangeLiveChannelWithAdIn(ms) {
            getContextManager.mockReturnValue({
                getAllChannelStates: () => new Map([[CHANNEL, { streamContext: { game: 'Chatting' } }]]),
            });
            axios.get.mockResolvedValue({
                data: { success: true, data: { data: [{ next_ad_at: new Date(Date.now() + ms).toISOString() }] } },
            });
        }

        test('enqueues a durable task ahead of the warning instead of a local timer', async () => {
            jest.useFakeTimers();
            try {
                arrangeLiveChannelWithAdIn(40 * 60_000); // 40 minutes out
                const adAtMs = Date.now() + 40 * 60_000;

                startAdSchedulePoller();
                await jest.advanceTimersByTimeAsync(30_000);

                expect(scheduleTask).toHaveBeenCalledTimes(1);
                const arg = scheduleTask.mock.calls[0][0];
                expect(arg.taskId).toBe(`ad-${CHANNEL}-${adAtMs}`);
                expect(arg.payload).toEqual({ kind: 'ad-notification', channelName: CHANNEL, adAtMs });

                // Delivered 60s (warning) + 20s (cold-start budget) before the ad.
                expect(arg.deliverAtMs).toBe(adAtMs - 60_000 - 20_000);

                // Nothing should fire locally, even well past the old fire time.
                await jest.advanceTimersByTimeAsync(40 * 60_000);
                expect(notifyAdSoon).not.toHaveBeenCalled();
            } finally {
                jest.useRealTimers();
            }
        });

        test('does not re-enqueue the same ad on subsequent ticks', async () => {
            jest.useFakeTimers();
            try {
                arrangeLiveChannelWithAdIn(40 * 60_000);

                startAdSchedulePoller();
                await jest.advanceTimersByTimeAsync(30_000);
                await jest.advanceTimersByTimeAsync(30_000);
                await jest.advanceTimersByTimeAsync(30_000);

                expect(scheduleTask).toHaveBeenCalledTimes(1);
            } finally {
                jest.useRealTimers();
            }
        });

        test('allows a retry on the next tick when enqueueing failed', async () => {
            jest.useFakeTimers();
            try {
                arrangeLiveChannelWithAdIn(40 * 60_000);
                scheduleTask.mockResolvedValueOnce({ scheduled: false, reason: 'queue unavailable' });

                startAdSchedulePoller();
                await jest.advanceTimersByTimeAsync(30_000);
                expect(scheduleTask).toHaveBeenCalledTimes(1);

                await jest.advanceTimersByTimeAsync(30_000);
                expect(scheduleTask).toHaveBeenCalledTimes(2);
            } finally {
                jest.useRealTimers();
            }
        });
    });
});
