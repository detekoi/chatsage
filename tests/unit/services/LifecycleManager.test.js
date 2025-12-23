import LifecycleManager from '../../../src/services/LifecycleManager.js';
import { getContextManager } from '../../../src/components/context/contextManager.js';
import { startStreamInfoPolling } from '../../../src/components/twitch/streamInfoPoller.js';
import { startAutoChatManager } from '../../../src/components/autoChat/autoChatManager.js';
import { startAdSchedulePoller } from '../../../src/components/twitch/adSchedulePoller.js';
import { getIrcClient, connectIrcClient } from '../../../src/components/twitch/ircClient.js';

// Mock dependencies
jest.mock('../../../src/components/twitch/helixClient.js');
jest.mock('../../../src/components/context/contextManager.js');
jest.mock('../../../src/components/twitch/streamInfoPoller.js');
jest.mock('../../../src/components/autoChat/autoChatManager.js');
jest.mock('../../../src/components/twitch/adSchedulePoller.js');
jest.mock('../../../src/components/twitch/ircClient.js');
jest.mock('../../../src/components/twitch/channelManager.js');
jest.mock('../../../src/lib/logger.js');
jest.mock('../../../src/config/index.js', () => ({
    twitch: { channels: ['testchannel'] },
    app: { streamInfoFetchIntervalMs: 60000, nodeEnv: 'test' }
}));

describe('LifecycleManager', () => {
    let lifecycleManager;
    let mockIrcClient;

    beforeEach(() => {
        jest.clearAllMocks();
        // Reset singleton instance
        LifecycleManager._instance = null;
        lifecycleManager = LifecycleManager.getInstance();

        mockIrcClient = {
            readyState: jest.fn(),
            connect: jest.fn(),
            disconnect: jest.fn(),
            join: jest.fn(),
            getChannels: jest.fn().mockReturnValue([])
        };
        getIrcClient.mockReturnValue(mockIrcClient);
        getContextManager.mockReturnValue({
            getAllChannelStates: jest.fn().mockReturnValue(new Map()),
            getContextForLLM: jest.fn()
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
        test('should connect IRC if streams are active and disconnected', async () => {
            lifecycleManager.activeStreams.add('testchannel');
            mockIrcClient.readyState.mockReturnValue('CLOSED');

            await lifecycleManager.reassessConnectionState();

            expect(connectIrcClient).toHaveBeenCalled();
        });

        test('should NOT connect IRC if no streams are active and LAZY_CONNECT is true', async () => {
            process.env.LAZY_CONNECT = 'true';
            mockIrcClient.readyState.mockReturnValue('CLOSED');

            await lifecycleManager.reassessConnectionState();

            expect(connectIrcClient).not.toHaveBeenCalled();
            delete process.env.LAZY_CONNECT;
        });

        test('should disconnect IRC if no streams active and LAZY_CONNECT is true', async () => {
            process.env.LAZY_CONNECT = 'true';
            mockIrcClient.readyState.mockReturnValue('OPEN');

            await lifecycleManager.reassessConnectionState();

            expect(mockIrcClient.disconnect).toHaveBeenCalled();
        });

        test('should ensure joined to active streams if already connected', async () => {
            lifecycleManager.activeStreams.add('testchannel');
            mockIrcClient.readyState.mockReturnValue('OPEN');
            mockIrcClient.getChannels.mockReturnValue([]); // Not joined yet

            await lifecycleManager.reassessConnectionState();

            expect(mockIrcClient.join).toHaveBeenCalledWith('#testchannel');
        });
    });
});
