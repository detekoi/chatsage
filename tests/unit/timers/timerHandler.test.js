// tests/unit/timers/timerHandler.test.js
import timerHandler from '../../../src/components/commands/handlers/timer.js';

const { execute } = timerHandler;

jest.mock('../../../src/components/timers/timersStorage.js', () => {
    const actual = jest.requireActual('../../../src/components/timers/timersStorage.js');
    return {
        ...actual,
        addTimer: jest.fn(),
        updateTimerResponse: jest.fn(),
        updateTimerOptions: jest.fn(),
        removeTimer: jest.fn(),
        getTimer: jest.fn(),
        getTimersForChannel: jest.fn(),
    };
});

jest.mock('../../../src/lib/logger.js', () => ({
    __esModule: true,
    default: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

jest.mock('../../../src/lib/ircSender.js');

// timersStorage is partially mocked above; findUnsupportedTimerVariables and the
// constants come from the real module via requireActual.
import {
    addTimer,
    updateTimerResponse,
    updateTimerOptions,
    removeTimer,
    getTimer,
    getTimersForChannel,
} from '../../../src/components/timers/timersStorage.js';
import { enqueueMessage } from '../../../src/lib/ircSender.js';
import logger from '../../../src/lib/logger.js';

describe('timer handler (!timer)', () => {
    const makeContext = (argsString) => ({
        channel: '#testchannel',
        user: { username: 'moduser', 'display-name': 'ModUser' },
        args: argsString ? argsString.split(' ') : [],
        logger: logger,
    });

    beforeEach(() => {
        jest.clearAllMocks();
        enqueueMessage.mockResolvedValue();
    });

    test('shows usage when called with no args', async () => {
        await execute(makeContext(''));
        expect(enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            expect.stringContaining('Usage'),
        );
    });

    test('shows error for unknown subcommand', async () => {
        await execute(makeContext('foo'));
        expect(enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            expect.stringContaining('Unknown subcommand'),
        );
    });

    // =========================================================================
    // add / addai
    // =========================================================================
    test('add creates a text timer with interval and default lines', async () => {
        addTimer.mockResolvedValue(true);
        await execute(makeContext('add promo 30 Follow us on socials!'));
        expect(addTimer).toHaveBeenCalledWith(
            'testchannel', 'promo', 'Follow us on socials!', 'moduser', 'text', 30, 5);
        expect(enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            expect.stringContaining('added'),
        );
    });

    test('addai creates a prompt timer', async () => {
        addTimer.mockResolvedValue(true);
        await execute(makeContext('addai hype 20 Hype up chat about the current game'));
        expect(addTimer).toHaveBeenCalledWith(
            'testchannel', 'hype', 'Hype up chat about the current game', 'moduser', 'prompt', 20, 5);
        expect(enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            expect.stringContaining('AI Mode'),
        );
    });

    test('add rejects a reserved name', async () => {
        await execute(makeContext('add list 30 some message'));
        expect(addTimer).not.toHaveBeenCalled();
        expect(enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            expect.stringContaining('reserved'),
        );
    });

    test('add sanitizes a messy name into a valid slug', async () => {
        addTimer.mockResolvedValue(true);
        await execute(makeContext('add Bad-Name! 30 some message'));
        expect(addTimer).toHaveBeenCalledWith(
            'testchannel', 'bad_name', 'some message', 'moduser', 'text', 30, 5);
    });

    test('add rejects a name that sanitizes to nothing', async () => {
        await execute(makeContext('add !!! 30 some message'));
        expect(addTimer).not.toHaveBeenCalled();
    });

    test('add rejects an out-of-range interval', async () => {
        await execute(makeContext('add promo 1 too fast'));
        expect(addTimer).not.toHaveBeenCalled();
        expect(enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            expect.stringContaining('interval'),
        );
    });

    test('add rejects a missing message', async () => {
        await execute(makeContext('add promo 30'));
        expect(addTimer).not.toHaveBeenCalled();
    });

    test('add rejects user-dependent variables in text timers', async () => {
        await execute(makeContext('add promo 30 Thanks $(user) for hanging out!'));
        expect(addTimer).not.toHaveBeenCalled();
        expect(enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            expect.stringContaining('$(user)'),
        );
    });

    test('addai allows user-dependent tokens (prompt text is free-form)', async () => {
        addTimer.mockResolvedValue(true);
        await execute(makeContext('addai hype 20 Talk about $(game) trivia'));
        expect(addTimer).toHaveBeenCalled();
    });

    test('add reports duplicates', async () => {
        addTimer.mockResolvedValue(false);
        await execute(makeContext('add promo 30 hello'));
        expect(enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            expect.stringContaining('already exists'),
        );
    });

    // =========================================================================
    // edit
    // =========================================================================
    test('edit updates an existing timer response', async () => {
        getTimer.mockResolvedValue({ name: 'promo', type: 'text' });
        updateTimerResponse.mockResolvedValue(true);
        await execute(makeContext('edit promo New message here'));
        expect(updateTimerResponse).toHaveBeenCalledWith('testchannel', 'promo', 'New message here');
    });

    test('edit rejects unsupported variables for text timers', async () => {
        getTimer.mockResolvedValue({ name: 'promo', type: 'text' });
        await execute(makeContext('edit promo Hi $(user)'));
        expect(updateTimerResponse).not.toHaveBeenCalled();
    });

    test('edit reports missing timer', async () => {
        getTimer.mockResolvedValue(null);
        await execute(makeContext('edit nope New message'));
        expect(updateTimerResponse).not.toHaveBeenCalled();
        expect(enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            expect.stringContaining('not found'),
        );
    });

    // =========================================================================
    // interval / lines / enable / disable
    // =========================================================================
    test('interval updates within bounds', async () => {
        updateTimerOptions.mockResolvedValue(true);
        await execute(makeContext('interval promo 45'));
        expect(updateTimerOptions).toHaveBeenCalledWith('testchannel', 'promo', { intervalMinutes: 45 });
    });

    test('interval rejects out-of-range values', async () => {
        await execute(makeContext('interval promo 99999'));
        expect(updateTimerOptions).not.toHaveBeenCalled();
    });

    test('lines updates within bounds', async () => {
        updateTimerOptions.mockResolvedValue(true);
        await execute(makeContext('lines promo 10'));
        expect(updateTimerOptions).toHaveBeenCalledWith('testchannel', 'promo', { minChatLines: 10 });
    });

    test('lines rejects out-of-range values', async () => {
        await execute(makeContext('lines promo 500'));
        expect(updateTimerOptions).not.toHaveBeenCalled();
    });

    test('enable and disable toggle the timer', async () => {
        updateTimerOptions.mockResolvedValue(true);
        await execute(makeContext('disable promo'));
        expect(updateTimerOptions).toHaveBeenCalledWith('testchannel', 'promo', { enabled: false });

        await execute(makeContext('enable promo'));
        expect(updateTimerOptions).toHaveBeenCalledWith('testchannel', 'promo', { enabled: true });
    });

    // =========================================================================
    // remove / show / list
    // =========================================================================
    test('remove deletes an existing timer', async () => {
        removeTimer.mockResolvedValue(true);
        await execute(makeContext('remove promo'));
        expect(removeTimer).toHaveBeenCalledWith('testchannel', 'promo');
        expect(enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            expect.stringContaining('removed'),
        );
    });

    test('show displays timer settings', async () => {
        getTimer.mockResolvedValue({
            name: 'hype', type: 'prompt', enabled: true,
            intervalMinutes: 20, minChatLines: 5, response: 'Hype it up',
        });
        await execute(makeContext('show hype'));
        expect(enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            expect.stringContaining('[AI]'),
        );
    });

    test('list summarizes all timers', async () => {
        getTimersForChannel.mockResolvedValue([
            { name: 'promo', type: 'text', intervalMinutes: 30, enabled: true },
            { name: 'hype', type: 'prompt', intervalMinutes: 20, enabled: false },
        ]);
        await execute(makeContext('list'));
        expect(enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            expect.stringContaining('Timers (2)'),
        );
    });

    test('list shows help when no timers exist', async () => {
        getTimersForChannel.mockResolvedValue([]);
        await execute(makeContext('list'));
        expect(enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            expect.stringContaining('No timers'),
        );
    });
});
