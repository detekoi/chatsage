import LifecycleManager from '../../../src/services/LifecycleManager.js';
import { getContextManager } from '../../../src/components/context/contextManager.js';
import { startStreamInfoPolling } from '../../../src/components/twitch/streamInfoPoller.js';
import { startAutoChatManager } from '../../../src/components/autoChat/autoChatManager.js';
import { startAdSchedulePoller } from '../../../src/components/twitch/adSchedulePoller.js';

// Mock dependencies
jest.mock('../../../src/components/twitch/helixClient.js');
jest.mock('../../../src/components/context/contextManager.js');
jest.mock('../../../src/components/twitch/streamInfoPoller.js');
jest.mock('../../../src/components/autoChat/autoChatManager.js');
jest.mock('../../../src/components/twitch/adSchedulePoller.js');
jest.mock('../../../src/components/twitch/channelManager.js');
jest.mock('../../../src/lib/logger.js');
jest.mock('../../../src/config/index.js', () => ({
    twitch: { channels: ['testchannel'] },
    app: { streamInfoFetchIntervalMs: 60000, nodeEnv: 'test' }
}));

describe('LifecycleManager', () => {
    let lifecycleManager;

    beforeEach(() => {
        jest.clearAllMocks();
        // Reset singleton instance
        LifecycleManager._instance = null;
        lifecycleManager = LifecycleManager.getInstance();

        getContextManager.mockReturnValue({
            getAllChannelStates: jest.fn().mockReturnValue(new Map()),
            getContextForLLM: jest.fn(),
            getStreamContextSnapshot: jest.fn().mockReturnValue(null)
        });
    });

    test('should be a singleton', () => {
        const instance1 = LifecycleManager.getInstance();
        const instance2 = LifecycleManager.getInstance();
        expect(instance1).toBe(instance2);
    });

    describe('startMonitoring', () => {
        test('should start all pollers and managers', async () => {
            await lifecycleManager.startMonitoring();

            expect(startStreamInfoPolling).toHaveBeenCalled();
            expect(startAutoChatManager).toHaveBeenCalled();
            expect(startAdSchedulePoller).toHaveBeenCalled();
            expect(lifecycleManager.isMonitoring).toBe(true);
        });

        test('should not start if already monitoring', async () => {
            lifecycleManager.isMonitoring = true;
            await lifecycleManager.startMonitoring();

            expect(startStreamInfoPolling).not.toHaveBeenCalled();
        });
    });

    describe('onStreamStatusChange', () => {
        test('should add stream to activeStreams when live', async () => {
            await lifecycleManager.onStreamStatusChange('testchannel', true);
            expect(lifecycleManager.activeStreams.has('testchannel')).toBe(true);
        });

        test('should remove stream from activeStreams when offline', async () => {
            lifecycleManager.activeStreams.add('testchannel');
            await lifecycleManager.onStreamStatusChange('testchannel', false);
            expect(lifecycleManager.activeStreams.has('testchannel')).toBe(false);
        });

        test('should trigger reassessConnectionState', async () => {
            const spy = jest.spyOn(lifecycleManager, 'reassessConnectionState');
            await lifecycleManager.onStreamStatusChange('testchannel', true);
            expect(spy).toHaveBeenCalled();
        });
    });

    describe('reassessConnectionState', () => {
        // With EventSub migration, reassessConnectionState is now a no-op.
        // These tests verify it completes without errors regardless of state.

        test('should complete without error when streams are active', async () => {
            lifecycleManager.activeStreams.add('testchannel');
            await expect(lifecycleManager.reassessConnectionState()).resolves.not.toThrow();
        });

        test('should complete without error when no streams are active', async () => {
            await expect(lifecycleManager.reassessConnectionState()).resolves.not.toThrow();
        });
    });

    describe('getActiveStreams', () => {
        test('should return array of active stream names', () => {
            lifecycleManager.activeStreams.add('channel1');
            lifecycleManager.activeStreams.add('channel2');
            const active = lifecycleManager.getActiveStreams();
            expect(active).toEqual(expect.arrayContaining(['channel1', 'channel2']));
            expect(active.length).toBe(2);
        });
    });
});
