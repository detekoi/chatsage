// tests/unit/timedGames/timedGamesManager.test.js
import {
    _tick,
    _handleConfigChange,
    _handleChannelAcquired,
    _getRuntime,
    stopTimedGamesManager,
    pickNextGame,
    isAnyGameActive,
} from '../../../src/components/timedGames/timedGamesManager.js';
import { isStreamLive } from '../../../src/components/context/liveStatus.js';
import { isCommandDisabled } from '../../../src/components/context/commandStateManager.js';
import { ownsChannel } from '../../../src/lib/channelOwnership.js';
import { sendLocalized } from '../../../src/lib/localizedMessage.js';
import { claimTimedGameRun, recordTimedGameRun } from '../../../src/components/timedGames/timedGamesStorage.js';
import { activeGames as triviaGames } from '../../../src/components/trivia/triviaGameManager.js';
import { activeGames as riddleGames } from '../../../src/components/riddle/riddleGameManager.js';

const mockTrivia = { startGame: jest.fn(), pickPreferredTopic: jest.fn() };
const mockGeo = { startGame: jest.fn(), pickPreferredGameTitle: jest.fn() };
const mockRiddle = { startGame: jest.fn() };

jest.mock('../../../src/lib/logger.js', () => ({
    __esModule: true,
    default: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../src/config/index.js', () => ({
    __esModule: true,
    default: { twitch: { username: 'ChatSageBot' } },
}));
jest.mock('../../../src/lib/localizedMessage.js', () => ({ sendLocalized: jest.fn() }));
jest.mock('../../../src/components/context/liveStatus.js', () => ({ isStreamLive: jest.fn() }));
jest.mock('../../../src/components/context/commandStateManager.js', () => ({ isCommandDisabled: jest.fn() }));
jest.mock('../../../src/lib/channelOwnership.js', () => ({
    ownsChannel: jest.fn(),
    onOwnershipChange: jest.fn(() => jest.fn()),
}));
jest.mock('../../../src/components/trivia/triviaGameManager.js', () => ({
    getTriviaGameManager: () => mockTrivia,
    activeGames: new Map(),
}));
jest.mock('../../../src/components/geo/geoGameManager.js', () => ({
    getGeoGameManager: () => mockGeo,
    activeGames: new Map(),
}));
jest.mock('../../../src/components/riddle/riddleGameManager.js', () => ({
    getRiddleGameManager: () => mockRiddle,
    activeGames: new Map(),
}));
jest.mock('../../../src/components/timedGames/timedGamesStorage.js', () => ({
    loadAllTimedGamesConfigs: jest.fn(async () => new Map()),
    listenForTimedGamesChanges: jest.fn(() => jest.fn()),
    claimTimedGameRun: jest.fn(),
    recordTimedGameRun: jest.fn(),
    TIMED_GAME_IDS: ['trivia', 'geo', 'riddle'],
}));

const CHANNEL = 'testchannel';

function setConfig(overrides = {}) {
    _handleConfigChange({
        type: 'added',
        channelName: CHANNEL,
        config: {
            enabled: true,
            intervalMinutes: 30,
            games: ['trivia', 'geo', 'riddle'],
            lastRunAtMs: 0,
            lastGame: null,
            ...overrides,
        },
    });
}

describe('timedGamesManager', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        stopTimedGamesManager();
        triviaGames.clear();
        riddleGames.clear();
        isStreamLive.mockReturnValue(true);
        ownsChannel.mockReturnValue(true);
        isCommandDisabled.mockReturnValue(false);
        claimTimedGameRun.mockImplementation(async (_ch, _ms, game) => ({ claimed: true, lastRunAtMs: Date.now(), lastGame: game }));
        mockTrivia.startGame.mockResolvedValue({ success: true });
        mockTrivia.pickPreferredTopic.mockResolvedValue(null);
        mockGeo.startGame.mockResolvedValue({ success: true });
        mockGeo.pickPreferredGameTitle.mockResolvedValue(null);
        mockRiddle.startGame.mockResolvedValue({ success: true });
    });

    test('starts the first game in the pool with the bot as initiator', async () => {
        setConfig();
        await _tick();
        expect(claimTimedGameRun).toHaveBeenCalledWith(CHANNEL, 30 * 60 * 1000, 'trivia');
        expect(sendLocalized).toHaveBeenCalledWith(`#${CHANNEL}`, 'timedGames.StartingTrivia', {}, expect.any(String));
        expect(mockTrivia.startGame).toHaveBeenCalledWith(CHANNEL, null, 'chatsagebot', 1);
        expect(_getRuntime().get(CHANNEL).lastGame).toBe('trivia');
    });

    test('does nothing while turned off', async () => {
        setConfig({ enabled: false });
        await _tick();
        expect(claimTimedGameRun).not.toHaveBeenCalled();
        expect(mockTrivia.startGame).not.toHaveBeenCalled();
    });

    test('does nothing while the stream is offline', async () => {
        setConfig();
        isStreamLive.mockReturnValue(false);
        await _tick();
        expect(mockTrivia.startGame).not.toHaveBeenCalled();
    });

    test('skips a channel this instance does not own', async () => {
        setConfig();
        ownsChannel.mockReturnValue(false);
        await _tick();
        expect(claimTimedGameRun).not.toHaveBeenCalled();
    });

    test('waits until the interval has elapsed', async () => {
        setConfig({ lastRunAtMs: Date.now() - 10 * 60 * 1000 });
        await _tick();
        expect(claimTimedGameRun).not.toHaveBeenCalled();
    });

    test('waits while another game is running, without moving the schedule', async () => {
        setConfig();
        riddleGames.set(CHANNEL, { state: 'inProgress' });
        await _tick();
        expect(claimTimedGameRun).not.toHaveBeenCalled();
        expect(_getRuntime().get(CHANNEL).lastRunAtMs).toBe(0);
    });

    test('rotates through the pool in order', async () => {
        setConfig({ lastGame: 'trivia' });
        await _tick();
        expect(mockGeo.startGame).toHaveBeenCalledWith(CHANNEL, 'real', null, 'chatsagebot', 1);

        _getRuntime().get(CHANNEL).lastRunAtMs = 0;
        await _tick();
        expect(mockRiddle.startGame).toHaveBeenCalledWith(CHANNEL, null, 'chatsagebot', 1);

        _getRuntime().get(CHANNEL).lastRunAtMs = 0;
        await _tick();
        expect(mockTrivia.startGame).toHaveBeenCalledTimes(1);
    });

    test('geo uses a preferred game title and skips the intro line', async () => {
        setConfig({ games: ['geo'] });
        mockGeo.pickPreferredGameTitle.mockResolvedValue('Elden Ring');
        await _tick();
        expect(mockGeo.startGame).toHaveBeenCalledWith(CHANNEL, 'game', 'Elden Ring', 'chatsagebot', 1);
        expect(sendLocalized).not.toHaveBeenCalled();
    });

    test('trivia uses a preferred topic and skips the intro line', async () => {
        setConfig({ games: ['trivia'] });
        mockTrivia.pickPreferredTopic.mockResolvedValue('Space');
        await _tick();
        expect(mockTrivia.startGame).toHaveBeenCalledWith(CHANNEL, 'Space', 'chatsagebot', 1);
        expect(sendLocalized).not.toHaveBeenCalled();
    });

    test('does not start when a viewer starts another game during the claim', async () => {
        setConfig();
        claimTimedGameRun.mockImplementation(async (_ch, _ms, game) => {
            riddleGames.set(CHANNEL, { state: 'inProgress' });
            return { claimed: true, lastRunAtMs: Date.now(), lastGame: game };
        });
        await _tick();
        expect(mockTrivia.startGame).not.toHaveBeenCalled();
        expect(sendLocalized).not.toHaveBeenCalled();
    });

    test('does not start when a viewer starts another game during the topic lookup', async () => {
        setConfig({ games: ['trivia'] });
        mockTrivia.pickPreferredTopic.mockImplementation(async () => {
            riddleGames.set(CHANNEL, { state: 'selecting' });
            return null;
        });
        await _tick();
        expect(mockTrivia.startGame).not.toHaveBeenCalled();
        expect(sendLocalized).not.toHaveBeenCalled();
    });

    test('skips a game whose command is disabled in the channel', async () => {
        setConfig();
        isCommandDisabled.mockImplementation((_ch, cmd) => cmd === 'trivia');
        await _tick();
        expect(mockTrivia.startGame).not.toHaveBeenCalled();
        expect(mockGeo.startGame).toHaveBeenCalled();
    });

    test('does nothing when every game in the pool is disabled', async () => {
        setConfig({ games: ['trivia'] });
        isCommandDisabled.mockReturnValue(true);
        await _tick();
        expect(claimTimedGameRun).not.toHaveBeenCalled();
    });

    test('does not start a game when the run was claimed elsewhere', async () => {
        setConfig();
        const otherRun = Date.now() - 1000;
        claimTimedGameRun.mockResolvedValue({ claimed: false, lastRunAtMs: otherRun, lastGame: 'trivia' });
        await _tick();
        expect(mockTrivia.startGame).not.toHaveBeenCalled();
        expect(_getRuntime().get(CHANNEL)).toEqual({ lastRunAtMs: otherRun, lastGame: 'trivia' });
    });

    test('starts anyway and records the run when the claim fails', async () => {
        setConfig();
        claimTimedGameRun.mockRejectedValue(new Error('firestore down'));
        await _tick();
        expect(mockTrivia.startGame).toHaveBeenCalled();
        expect(recordTimedGameRun).toHaveBeenCalledWith(CHANNEL, 'trivia');
    });

    test('a failed start still advances the rotation', async () => {
        setConfig();
        mockTrivia.startGame.mockResolvedValue({ success: false, error: 'no question' });
        await _tick();
        expect(_getRuntime().get(CHANNEL).lastGame).toBe('trivia');
        expect(_getRuntime().get(CHANNEL).lastRunAtMs).toBeGreaterThan(0);
    });

    test('the bot\'s own lastRunAt echo does not rewind runtime', async () => {
        setConfig();
        await _tick();
        const after = { ..._getRuntime().get(CHANNEL) };
        _handleConfigChange({
            type: 'modified',
            channelName: CHANNEL,
            config: { enabled: true, intervalMinutes: 30, games: ['trivia', 'geo', 'riddle'], lastRunAtMs: 1, lastGame: null },
        });
        expect(_getRuntime().get(CHANNEL)).toEqual(after);
    });

    test('acquiring a channel reseeds runtime from the stored schedule', () => {
        setConfig({ lastRunAtMs: 123, lastGame: 'geo' });
        _getRuntime().set(CHANNEL, { lastRunAtMs: 0, lastGame: null });
        _handleChannelAcquired({ type: 'acquired', channelName: CHANNEL });
        expect(_getRuntime().get(CHANNEL)).toEqual({ lastRunAtMs: 123, lastGame: 'geo' });
    });

    test('a removed config stops timed games for the channel', async () => {
        setConfig();
        _handleConfigChange({ type: 'removed', channelName: CHANNEL, config: null });
        await _tick();
        expect(claimTimedGameRun).not.toHaveBeenCalled();
    });

    describe('pickNextGame', () => {
        test('wraps around to the start of the pool', () => {
            expect(pickNextGame(CHANNEL, ['trivia', 'riddle'], 'riddle')).toBe('trivia');
        });

        test('continues from a last game that left the pool', () => {
            expect(pickNextGame(CHANNEL, ['trivia', 'riddle'], 'geo')).toBe('riddle');
        });
    });

    test('isAnyGameActive ignores idle games', () => {
        triviaGames.set(CHANNEL, { state: 'idle' });
        expect(isAnyGameActive(CHANNEL)).toBe(false);
        triviaGames.set(CHANNEL, { state: 'ending' });
        expect(isAnyGameActive(CHANNEL)).toBe(true);
    });
});
