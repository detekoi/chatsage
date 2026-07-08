// tests/unit/timers/timerManager.test.js
import {
    _tick,
    _handleTimerChange,
    _getRuntime,
    _getConfigCache,
    stopTimerManager,
} from '../../../src/components/timers/timerManager.js';
import { getContextManager } from '../../../src/components/context/contextManager.js';
import { getMessageCount } from '../../../src/components/context/channelActivity.js';
import { isStreamLive } from '../../../src/components/context/liveStatus.js';
import { enqueueMessage } from '../../../src/lib/ircSender.js';
import { resolvePrompt } from '../../../src/components/customCommands/promptResolver.js';
import { recordTimerRun } from '../../../src/components/timers/timersStorage.js';

jest.mock('../../../src/lib/logger.js', () => ({
    __esModule: true,
    default: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../src/lib/ircSender.js');
jest.mock('../../../src/components/context/contextManager.js');
jest.mock('../../../src/components/context/channelActivity.js');
jest.mock('../../../src/components/context/liveStatus.js');
jest.mock('../../../src/components/customCommands/promptResolver.js');
jest.mock('../../../src/components/timers/timersStorage.js', () => ({
    loadAllTimers: jest.fn(async () => new Map()),
    listenForTimerChanges: jest.fn(() => jest.fn()),
    recordTimerRun: jest.fn(),
    DEFAULT_INTERVAL_MINUTES: 15,
    DEFAULT_MIN_CHAT_LINES: 5,
}));

const CHANNEL = 'testchannel';

function addTimer(overrides = {}) {
    const timer = {
        name: 'promo',
        response: 'Check out the socials!',
        type: 'text',
        intervalMinutes: 15,
        minChatLines: 5,
        enabled: true,
        useCount: 0,
        lastRunAt: null,
        ...overrides,
    };
    _handleTimerChange({ type: 'added', channelName: CHANNEL, timerName: timer.name, timer });
    return timer;
}

describe('timerManager tick', () => {
    let mockContextManager;

    beforeEach(() => {
        jest.clearAllMocks();
        stopTimerManager(); // clears configCache + runtime

        mockContextManager = {
            getStreamContextSnapshot: jest.fn(() => ({ game: 'Planet Zoo', startedAt: new Date().toISOString() })),
            getBotLanguage: jest.fn(() => null),
            getContextForLLM: jest.fn(() => ({
                streamGame: 'Planet Zoo',
                streamTitle: 'Zoo time',
                streamStartedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
                recentChatHistory: 'user1: hello',
            })),
        };
        getContextManager.mockReturnValue(mockContextManager);
        isStreamLive.mockReturnValue(true);
        getMessageCount.mockReturnValue(0);
        enqueueMessage.mockResolvedValue();
        resolvePrompt.mockResolvedValue('AI generated message');
    });

    test('fires a due text timer and records the run', async () => {
        addTimer();
        getMessageCount.mockReturnValue(10); // 10 lines since seed at 0... seed reads 10 too

        // Seeding happens at add time with the current count; raise the count afterwards
        _getRuntime().get(CHANNEL).get('promo').lastSeenMessageCount = 0;

        await _tick();

        expect(enqueueMessage).toHaveBeenCalledWith(`#${CHANNEL}`, 'Check out the socials!', { skipTranslation: false });
        expect(recordTimerRun).toHaveBeenCalledWith(CHANNEL, 'promo');
        expect(_getRuntime().get(CHANNEL).get('promo').lastRunAtMs).toBeGreaterThan(0);
    });

    test('does not fire when the stream is offline', async () => {
        isStreamLive.mockReturnValue(false);
        addTimer();
        getMessageCount.mockReturnValue(100);
        _getRuntime().get(CHANNEL).get('promo').lastSeenMessageCount = 0;

        await _tick();

        expect(enqueueMessage).not.toHaveBeenCalled();
    });

    test('does not fire a disabled timer', async () => {
        addTimer({ enabled: false });
        getMessageCount.mockReturnValue(100);
        _getRuntime().get(CHANNEL).get('promo').lastSeenMessageCount = 0;

        await _tick();

        expect(enqueueMessage).not.toHaveBeenCalled();
    });

    test('does not fire before the interval has elapsed', async () => {
        addTimer({ lastRunAt: { toMillis: () => Date.now() - 60 * 1000 } }); // ran 1 min ago, interval 15m
        getMessageCount.mockReturnValue(100);
        _getRuntime().get(CHANNEL).get('promo').lastSeenMessageCount = 0;

        await _tick();

        expect(enqueueMessage).not.toHaveBeenCalled();
    });

    test('does not fire without enough chat lines since the last run', async () => {
        addTimer({ minChatLines: 5 });
        getMessageCount.mockReturnValue(3);
        _getRuntime().get(CHANNEL).get('promo').lastSeenMessageCount = 0;

        await _tick();

        expect(enqueueMessage).not.toHaveBeenCalled();
    });

    test('minChatLines of 0 disables the chat-activity gate', async () => {
        addTimer({ minChatLines: 0 });
        getMessageCount.mockReturnValue(0);

        await _tick();

        expect(enqueueMessage).toHaveBeenCalled();
    });

    test('fires at most one timer per channel per tick, longest-starved first', async () => {
        addTimer({ name: 'newer', lastRunAt: { toMillis: () => Date.now() - 30 * 60 * 1000 } });
        addTimer({ name: 'older', lastRunAt: { toMillis: () => Date.now() - 60 * 60 * 1000 } });
        getMessageCount.mockReturnValue(100);
        _getRuntime().get(CHANNEL).get('newer').lastSeenMessageCount = 0;
        _getRuntime().get(CHANNEL).get('older').lastSeenMessageCount = 0;

        await _tick();

        expect(enqueueMessage).toHaveBeenCalledTimes(1);
        expect(enqueueMessage).toHaveBeenCalledWith(`#${CHANNEL}`, expect.any(String), expect.any(Object));
        expect(recordTimerRun).toHaveBeenCalledWith(CHANNEL, 'older');
    });

    test('prompt timers call resolvePrompt with timer source and chat context', async () => {
        addTimer({ name: 'hype', type: 'prompt', response: 'Hype up the stream' });
        getMessageCount.mockReturnValue(100);
        _getRuntime().get(CHANNEL).get('hype').lastSeenMessageCount = 0;

        await _tick();

        expect(resolvePrompt).toHaveBeenCalledWith(
            'Hype up the stream',
            null,
            expect.stringContaining('Game: Planet Zoo'),
            false,
            expect.objectContaining({
                channel: CHANNEL,
                source: 'timer:hype',
                chatContext: 'user1: hello',
            }),
        );
        expect(enqueueMessage).toHaveBeenCalledWith(`#${CHANNEL}`, 'AI generated message', { skipTranslation: false });
    });

    test('prompt timer with botLanguage skips translation', async () => {
        mockContextManager.getBotLanguage.mockReturnValue('Spanish');
        addTimer({ name: 'hype', type: 'prompt', response: 'Hype up the stream' });
        getMessageCount.mockReturnValue(100);
        _getRuntime().get(CHANNEL).get('hype').lastSeenMessageCount = 0;

        await _tick();

        expect(resolvePrompt).toHaveBeenCalledWith(
            expect.any(String), 'Spanish', expect.any(String), false, expect.any(Object));
        expect(enqueueMessage).toHaveBeenCalledWith(`#${CHANNEL}`, 'AI generated message', { skipTranslation: true });
    });

    test('skips silently when the LLM returns nothing, without re-firing next tick', async () => {
        resolvePrompt.mockResolvedValue(null);
        addTimer({ name: 'hype', type: 'prompt', response: 'Hype up the stream' });
        getMessageCount.mockReturnValue(100);
        _getRuntime().get(CHANNEL).get('hype').lastSeenMessageCount = 0;

        await _tick();

        expect(enqueueMessage).not.toHaveBeenCalled();
        expect(recordTimerRun).not.toHaveBeenCalled();
        // Runtime advanced anyway → interval gate blocks an immediate retry
        expect(_getRuntime().get(CHANNEL).get('hype').lastRunAtMs).toBeGreaterThan(0);

        await _tick();
        expect(resolvePrompt).toHaveBeenCalledTimes(1);
    });

    test('drops the message if the timer was deleted during generation', async () => {
        addTimer({ name: 'hype', type: 'prompt', response: 'Hype up the stream' });
        getMessageCount.mockReturnValue(100);
        _getRuntime().get(CHANNEL).get('hype').lastSeenMessageCount = 0;

        resolvePrompt.mockImplementation(async () => {
            _handleTimerChange({ type: 'removed', channelName: CHANNEL, timerName: 'hype', timer: {} });
            return 'AI generated message';
        });

        await _tick();

        expect(enqueueMessage).not.toHaveBeenCalled();
    });

    test('snapshot "modified" updates config without resetting runtime state', async () => {
        const timer = addTimer();
        getMessageCount.mockReturnValue(100);
        _getRuntime().get(CHANNEL).get('promo').lastSeenMessageCount = 0;

        await _tick();
        const lastRunAtMs = _getRuntime().get(CHANNEL).get('promo').lastRunAtMs;
        expect(lastRunAtMs).toBeGreaterThan(0);

        // Simulate the bot's own lastRunAt write echoing back through the listener
        _handleTimerChange({
            type: 'modified',
            channelName: CHANNEL,
            timerName: 'promo',
            timer: { ...timer, intervalMinutes: 30, lastRunAt: { toMillis: () => 0 } },
        });

        expect(_getConfigCache().get(CHANNEL).get('promo').intervalMinutes).toBe(30);
        expect(_getRuntime().get(CHANNEL).get('promo').lastRunAtMs).toBe(lastRunAtMs);
    });

    test('resolves $(...) variables in text timers', async () => {
        addTimer({ name: 'game', response: 'Now playing $(game) in $(channel)!' });
        getMessageCount.mockReturnValue(100);
        _getRuntime().get(CHANNEL).get('game').lastSeenMessageCount = 0;

        await _tick();

        expect(enqueueMessage).toHaveBeenCalledWith(
            `#${CHANNEL}`,
            `Now playing Planet Zoo in ${CHANNEL}!`,
            { skipTranslation: false },
        );
    });
});
