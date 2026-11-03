// tests/unit/components/commands/handlers/timedgames.test.js

jest.mock('../../../../../src/lib/logger.js');
jest.mock('../../../../../src/lib/ircSender.js');
jest.mock('../../../../../src/components/context/contextManager.js');
jest.mock('../../../../../src/components/timedGames/timedGamesManager.js', () => ({
    pickNextGame: jest.fn(),
}));
jest.mock('../../../../../src/components/timedGames/timedGamesStorage.js', () => {
    const actual = jest.requireActual('../../../../../src/components/timedGames/timedGamesStorage.js');
    return {
        ...actual,
        getTimedGamesConfig: jest.fn(),
        saveTimedGamesConfig: jest.fn(),
    };
});

import handler from '../../../../../src/components/commands/handlers/timedgames.js';
import { enqueueMessage } from '../../../../../src/lib/ircSender.js';
import { getContextManager } from '../../../../../src/components/context/contextManager.js';
import { pickNextGame } from '../../../../../src/components/timedGames/timedGamesManager.js';
import { getTimedGamesConfig, saveTimedGamesConfig } from '../../../../../src/components/timedGames/timedGamesStorage.js';

const CHANNEL = '#testchannel';
const OPTS = { replyToId: 'msg-1' };

describe('!timedgames', () => {
    const run = args => handler.execute({ channel: CHANNEL, user: { id: 'msg-1', username: 'mod' }, args });

    beforeEach(() => {
        jest.clearAllMocks();
        enqueueMessage.mockResolvedValue();
        getContextManager.mockReturnValue({ getBotLanguage: () => null });
        getTimedGamesConfig.mockResolvedValue({ enabled: false, intervalMinutes: 30, games: ['trivia', 'riddle'], lastRunAtMs: 0, lastGame: null });
        saveTimedGamesConfig.mockResolvedValue(true);
        pickNextGame.mockReturnValue('riddle');
    });

    test('is mod-only', () => {
        expect(handler.permission).toBe('moderator');
    });

    test('reports status while off', async () => {
        await run([]);
        expect(enqueueMessage).toHaveBeenCalledWith(CHANNEL,
            'Timed games are off. When on, the bot starts a game every 30 min from: trivia, riddle. Turn them on with !timedgames on', OPTS);
    });

    test('reports status and the next game while on', async () => {
        getTimedGamesConfig.mockResolvedValue({ enabled: true, intervalMinutes: 30, games: ['trivia', 'riddle'], lastRunAtMs: 0, lastGame: 'trivia' });
        await run(['status']);
        expect(pickNextGame).toHaveBeenCalledWith('testchannel', ['trivia', 'riddle'], 'trivia');
        expect(enqueueMessage).toHaveBeenCalledWith(CHANNEL,
            'Timed games are on: a game every 30 min while live, from: trivia, riddle. Next up: riddle', OPTS);
    });

    test('turns timed games on', async () => {
        await run(['on']);
        expect(saveTimedGamesConfig).toHaveBeenCalledWith('testchannel', { enabled: true });
        expect(enqueueMessage).toHaveBeenCalledWith(CHANNEL, expect.stringContaining('Timed games are on.'), OPTS);
    });

    test('turns timed games off', async () => {
        await run(['OFF']);
        expect(saveTimedGamesConfig).toHaveBeenCalledWith('testchannel', { enabled: false });
        expect(enqueueMessage).toHaveBeenCalledWith(CHANNEL, 'Timed games are off. Games now start only from chat commands.', OPTS);
    });

    test('sets the interval', async () => {
        await run(['interval', '15']);
        expect(saveTimedGamesConfig).toHaveBeenCalledWith('testchannel', { intervalMinutes: 15 });
        expect(enqueueMessage).toHaveBeenCalledWith(CHANNEL, 'Timed games now start every 15 min.', OPTS);
    });

    test.each([['4'], ['721'], ['10.5'], ['abc'], [undefined]])('rejects interval %s', async (value) => {
        await run(['interval', value].filter(v => v !== undefined));
        expect(saveTimedGamesConfig).not.toHaveBeenCalled();
        expect(enqueueMessage).toHaveBeenCalledWith(CHANNEL,
            'Give the interval in whole minutes, from 5 to 720. Example: !timedgames interval 30', OPTS);
    });

    test('sets the game pool in canonical order', async () => {
        await run(['games', 'riddle,', 'Trivia']);
        expect(saveTimedGamesConfig).toHaveBeenCalledWith('testchannel', { games: ['trivia', 'riddle'] });
        expect(enqueueMessage).toHaveBeenCalledWith(CHANNEL, 'Timed games now rotate through: trivia, riddle.', OPTS);
    });

    test.each([[[]], [['chess']], [['trivia,chess']]])('rejects game list %j', async (list) => {
        await run(['games', ...list]);
        expect(saveTimedGamesConfig).not.toHaveBeenCalled();
        expect(enqueueMessage).toHaveBeenCalledWith(CHANNEL,
            'Name one or more of these games: trivia, geo, riddle. Example: !timedgames games trivia,riddle', OPTS);
    });

    test('reports a failed save', async () => {
        saveTimedGamesConfig.mockResolvedValue(false);
        await run(['on']);
        expect(enqueueMessage).toHaveBeenCalledTimes(1);
        expect(enqueueMessage).toHaveBeenCalledWith(CHANNEL, 'Could not save the timed games settings. Please try again.', OPTS);
    });

    test('shows usage for an unknown subcommand', async () => {
        await run(['bogus']);
        expect(enqueueMessage).toHaveBeenCalledWith(CHANNEL,
            'Usage: !timedgames [on|off] | !timedgames interval <minutes> | !timedgames games trivia,geo,riddle', OPTS);
    });
});
