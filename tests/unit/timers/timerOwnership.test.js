// tests/unit/timers/timerOwnership.test.js
// With several instances running, a timer must post once per run: only the
// channel's owner evaluates it, and each run is claimed in Firestore first.
import {
    _tick,
    _handleTimerChange,
    _getRuntime,
    startTimerManager,
    stopTimerManager,
} from '../../../src/components/timers/timerManager.js';
import { getContextManager } from '../../../src/components/context/contextManager.js';
import { getMessageCount, getLastMessageAt } from '../../../src/components/context/channelActivity.js';
import { isStreamLive } from '../../../src/components/context/liveStatus.js';
import { enqueueMessage } from '../../../src/lib/ircSender.js';
import { loadAllTimers, claimTimerRun, recordTimerRun } from '../../../src/components/timers/timersStorage.js';
import { ownsChannel, onOwnershipChange } from '../../../src/lib/channelOwnership.js';
import { defaultPrefetchCache } from '../../../src/lib/prefetchCache.js';

jest.mock('../../../src/lib/logger.js');
jest.mock('../../../src/lib/ircSender.js');
jest.mock('../../../src/components/context/contextManager.js');
jest.mock('../../../src/components/context/channelActivity.js');
jest.mock('../../../src/components/context/liveStatus.js');
jest.mock('../../../src/components/customCommands/promptResolver.js');
jest.mock('../../../src/lib/channelOwnership.js', () => ({
    ownsChannel: jest.fn(() => true),
    onOwnershipChange: jest.fn(() => jest.fn()),
}));
jest.mock('../../../src/components/timers/timersStorage.js', () => ({
    loadAllTimers: jest.fn(async () => new Map()),
    listenForTimerChanges: jest.fn(() => jest.fn()),
    claimTimerRun: jest.fn(),
    recordTimerRun: jest.fn(),
    DEFAULT_INTERVAL_MINUTES: 15,
    DEFAULT_MIN_CHAT_LINES: 5,
}));

const CHANNEL = 'parfaitfair';
const MINUTE = 60 * 1000;

function timerDoc(lastRunAtMs, overrides = {}) {
    return {
        name: 'mobile_sub_discount',
        response: 'Subs are cheaper on mobile!',
        type: 'text',
        intervalMinutes: 15,
        minChatLines: 0,
        enabled: true,
        useCount: 0,
        lastRunAt: lastRunAtMs ? { toMillis: () => lastRunAtMs } : null,
        ...overrides,
    };
}

function addDueTimer() {
    const timer = timerDoc(Date.now() - 20 * MINUTE);
    _handleTimerChange({ type: 'added', channelName: CHANNEL, timerName: timer.name, timer });
    return timer;
}

describe('timer ownership', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        stopTimerManager();
        getContextManager.mockReturnValue({
            getStreamContextSnapshot: jest.fn(() => ({ game: 'Zelda', startedAt: new Date().toISOString() })),
            getBotLanguage: jest.fn(() => null),
            getContextForLLM: jest.fn(() => ({ streamGame: 'Zelda', recentChatHistory: '' })),
        });
        isStreamLive.mockReturnValue(true);
        getMessageCount.mockReturnValue(0);
        getLastMessageAt.mockReturnValue(Date.now());
        enqueueMessage.mockResolvedValue();
        ownsChannel.mockReturnValue(true);
        claimTimerRun.mockResolvedValue({ claimed: true, lastRunAtMs: Date.now() });
    });

    afterEach(() => {
        stopTimerManager();
    });

    test('does not evaluate timers for a channel another instance owns', async () => {
        addDueTimer();
        ownsChannel.mockReturnValue(false);

        await _tick();

        expect(claimTimerRun).not.toHaveBeenCalled();
        expect(enqueueMessage).not.toHaveBeenCalled();
    });

    test('claims the run before posting', async () => {
        addDueTimer();

        await _tick();

        expect(claimTimerRun).toHaveBeenCalledWith(CHANNEL, 'mobile_sub_discount', 15 * MINUTE);
        expect(claimTimerRun.mock.invocationCallOrder[0]).toBeLessThan(enqueueMessage.mock.invocationCallOrder[0]);
        expect(enqueueMessage).toHaveBeenCalledTimes(1);
    });

    test('a run already claimed elsewhere is skipped and adopted', async () => {
        addDueTimer();
        const otherInstanceFiredAt = Date.now() - 5000;
        claimTimerRun.mockResolvedValue({ claimed: false, lastRunAtMs: otherInstanceFiredAt });

        await _tick();

        expect(enqueueMessage).not.toHaveBeenCalled();
        expect(recordTimerRun).not.toHaveBeenCalled();
        expect(_getRuntime().get(CHANNEL).get('mobile_sub_discount').lastRunAtMs).toBe(otherInstanceFiredAt);

        // Adopting the other run means the next tick does not try again.
        claimTimerRun.mockClear();
        await _tick();
        expect(claimTimerRun).not.toHaveBeenCalled();
    });

    test('fires anyway when the claim cannot reach Firestore, and records the run afterwards', async () => {
        addDueTimer();
        claimTimerRun.mockRejectedValue(new Error('UNAVAILABLE'));

        await _tick();

        expect(enqueueMessage).toHaveBeenCalledTimes(1);
        // The claim never wrote lastRunAt; without this the next owner would
        // find the timer overdue and post it again.
        expect(recordTimerRun).toHaveBeenCalledWith(CHANNEL, 'mobile_sub_discount', { writeLastRunAt: true });
    });

    test('a claimed run leaves lastRunAt to the claim', async () => {
        addDueTimer();

        await _tick();

        expect(recordTimerRun).toHaveBeenCalledWith(CHANNEL, 'mobile_sub_discount', { writeLastRunAt: false });
    });

    test('the echo of the claim\'s own lastRunAt write keeps the prefetched message', () => {
        const timer = timerDoc(Date.now() - 20 * MINUTE, { type: 'prompt' });
        _handleTimerChange({ type: 'added', channelName: CHANNEL, timerName: timer.name, timer });
        const clearSpy = jest.spyOn(defaultPrefetchCache, 'clear');

        _handleTimerChange({
            type: 'modified',
            channelName: CHANNEL,
            timerName: timer.name,
            timer: { ...timer, lastRunAt: { toMillis: () => Date.now() }, useCount: 1 },
        });
        expect(clearSpy).not.toHaveBeenCalled();

        _handleTimerChange({
            type: 'modified',
            channelName: CHANNEL,
            timerName: timer.name,
            timer: { ...timer, response: 'Share one new gaming headline' },
        });
        expect(clearSpy).toHaveBeenCalledWith(`timer:${CHANNEL}:${timer.name}`);
        clearSpy.mockRestore();
    });

    test('a newly acquired channel continues the previous owner\'s schedule', async () => {
        loadAllTimers.mockResolvedValue(new Map([[CHANNEL, new Map()]]));
        await startTimerManager();
        const acquiredHandler = onOwnershipChange.mock.calls[0][0];

        // This instance booted when the timer was long overdue...
        const stale = timerDoc(Date.now() - 60 * MINUTE);
        _handleTimerChange({ type: 'added', channelName: CHANNEL, timerName: stale.name, timer: stale });
        // ...then the owner fired it, and the listener delivered the new lastRunAt.
        const justFired = timerDoc(Date.now() - 2 * MINUTE);
        _handleTimerChange({ type: 'modified', channelName: CHANNEL, timerName: justFired.name, timer: justFired });
        expect(_getRuntime().get(CHANNEL).get('mobile_sub_discount').lastRunAtMs).toBeLessThan(Date.now() - 50 * MINUTE);

        acquiredHandler({ type: 'acquired', channelName: CHANNEL, broadcasterId: '111' });

        expect(_getRuntime().get(CHANNEL).get('mobile_sub_discount').lastRunAtMs).toBe(justFired.lastRunAt.toMillis());
        await _tick();
        expect(enqueueMessage).not.toHaveBeenCalled();
    });
});
