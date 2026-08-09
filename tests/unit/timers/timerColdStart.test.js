// tests/unit/timers/timerColdStart.test.js
// Cloud Run recycles idle instances every ~15 minutes. The message counter
// resets with the process, so a baseline captured at startup cannot describe
// chat since the timer last fired on a previous instance. These tests pin the
// restart-safe fallback that replaces it.
import {
    _tick,
    _getRuntime,
    _handleTimerChange,
    startTimerManager,
    stopTimerManager,
} from '../../../src/components/timers/timerManager.js';
import { getContextManager } from '../../../src/components/context/contextManager.js';
import { getMessageCount, getLastMessageAt } from '../../../src/components/context/channelActivity.js';
import { isStreamLive } from '../../../src/components/context/liveStatus.js';
import { enqueueMessage } from '../../../src/lib/ircSender.js';
import { loadAllTimers } from '../../../src/components/timers/timersStorage.js';

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

const CHANNEL = 'parfaitfair';
const MINUTE = 60 * 1000;

function persistedTimer(lastRunAtMs, overrides = {}) {
    return {
        name: 'promo',
        response: 'Check out the socials!',
        type: 'text',
        intervalMinutes: 15,
        minChatLines: 5,
        enabled: true,
        useCount: 0,
        lastRunAt: { toMillis: () => lastRunAtMs },
        ...overrides,
    };
}

/** Simulates a cold start that loads this timer from Firestore. */
async function bootWith(timer) {
    loadAllTimers.mockResolvedValue(new Map([[CHANNEL, new Map([[timer.name, timer]])]]));
    await startTimerManager();
}

describe('timerManager cold start', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        stopTimerManager();

        getContextManager.mockReturnValue({
            getStreamContextSnapshot: jest.fn(() => ({ game: 'Planet Zoo', startedAt: new Date().toISOString() })),
            getBotLanguage: jest.fn(() => null),
            getContextForLLM: jest.fn(() => ({ streamGame: 'Planet Zoo', recentChatHistory: '' })),
        });
        isStreamLive.mockReturnValue(true);
    });

    afterEach(() => {
        stopTimerManager();
    });

    test('marks a startup-seeded baseline as untrustworthy', async () => {
        getMessageCount.mockReturnValue(0);
        getLastMessageAt.mockReturnValue(Date.now());

        await bootWith(persistedTimer(Date.now() - 20 * MINUTE));

        expect(_getRuntime().get(CHANNEL).get('promo').countBaselineValid).toBe(false);
    });

    test('fires after a restart when chat has spoken since the last run, despite a reset counter', async () => {
        const lastRunAtMs = Date.now() - 20 * MINUTE; // interval of 15m has elapsed
        // Fresh instance: only two messages observed, below minChatLines of 5.
        getMessageCount.mockReturnValue(2);
        // But lastMessageAt is seeded from history and is newer than the last run.
        getLastMessageAt.mockReturnValue(Date.now() - 5 * MINUTE);

        await bootWith(persistedTimer(lastRunAtMs));
        await _tick();

        expect(enqueueMessage).toHaveBeenCalledWith(`#${CHANNEL}`, 'Check out the socials!', expect.any(Object));
    });

    test('stays silent after a restart when chat has not spoken since the last run', async () => {
        const lastRunAtMs = Date.now() - 20 * MINUTE;
        getMessageCount.mockReturnValue(100);
        // Last chat predates the timer's last run: the channel is dead.
        getLastMessageAt.mockReturnValue(lastRunAtMs - 5 * MINUTE);

        await bootWith(persistedTimer(lastRunAtMs));
        await _tick();

        expect(enqueueMessage).not.toHaveBeenCalled();
    });

    test('stays silent after a restart when no chat has ever been seen', async () => {
        getMessageCount.mockReturnValue(0);
        getLastMessageAt.mockReturnValue(0);

        await bootWith(persistedTimer(Date.now() - 20 * MINUTE));
        await _tick();

        expect(enqueueMessage).not.toHaveBeenCalled();
    });

    test('still respects the interval after a restart', async () => {
        // Ran 5 minutes ago against a 15 minute interval: not due yet.
        getMessageCount.mockReturnValue(100);
        getLastMessageAt.mockReturnValue(Date.now());

        await bootWith(persistedTimer(Date.now() - 5 * MINUTE));
        await _tick();

        expect(enqueueMessage).not.toHaveBeenCalled();
    });

    test('switches to the counter gate once the timer has fired in this process', async () => {
        const lastRunAtMs = Date.now() - 20 * MINUTE;
        getMessageCount.mockReturnValue(2);
        getLastMessageAt.mockReturnValue(Date.now() - 5 * MINUTE);

        await bootWith(persistedTimer(lastRunAtMs));
        await _tick();
        expect(enqueueMessage).toHaveBeenCalledTimes(1);

        const state = _getRuntime().get(CHANNEL).get('promo');
        expect(state.countBaselineValid).toBe(true);
        expect(state.lastSeenMessageCount).toBe(2);
    });

    test('a timer added while running uses the counter gate immediately', async () => {
        getMessageCount.mockReturnValue(10);
        getLastMessageAt.mockReturnValue(Date.now());

        await bootWith(persistedTimer(Date.now() - 20 * MINUTE, { name: 'other' }));

        const timer = persistedTimer(0, { name: 'fresh', lastRunAt: null });
        _handleTimerChange({ type: 'added', channelName: CHANNEL, timerName: 'fresh', timer });

        expect(_getRuntime().get(CHANNEL).get('fresh').countBaselineValid).toBe(true);
        expect(_getRuntime().get(CHANNEL).get('fresh').lastSeenMessageCount).toBe(10);
    });
});
