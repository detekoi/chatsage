// tests/unit/components/commands/handlers/gameHandlerUtils.test.js

jest.mock('../../../../../src/lib/logger.js');
jest.mock('../../../../../src/lib/ircSender.js');
jest.mock('../../../../../src/lib/permissions.js');

import {
    safeReply,
    extractGameContext,
    handleStop,
    handleLeaderboard,
    handleClearLeaderboard,
    handleResetConfig,
    handleReport,
    handleConfig,
    validateRounds,
    startGameWithErrorHandling,
    isPositiveInteger,
} from '../../../../../src/components/commands/handlers/gameHandlerUtils.js';
import { enqueueMessage } from '../../../../../src/lib/ircSender.js';
import { isPrivilegedUser } from '../../../../../src/lib/permissions.js';
import logger from '../../../../../src/lib/logger.js';

describe('gameHandlerUtils', () => {
    const createGameCtx = (overrides = {}) => ({
        channel: '#testchannel',
        channelName: 'testchannel',
        username: 'testuser',
        displayName: 'TestUser',
        replyToId: '123',
        isMod: false,
        args: [],
        ...overrides,
    });

    beforeEach(() => {
        jest.clearAllMocks();
        enqueueMessage.mockResolvedValue();
        isPrivilegedUser.mockReturnValue(false);
    });

    // --- isPositiveInteger ---
    describe('isPositiveInteger', () => {
        test('should accept positive integers', () => {
            expect(isPositiveInteger('1')).toBe(true);
            expect(isPositiveInteger('5')).toBe(true);
            expect(isPositiveInteger('123')).toBe(true);
        });

        test('should reject zero, negative, and non-numeric strings', () => {
            expect(isPositiveInteger('0')).toBe(false);
            expect(isPositiveInteger('-1')).toBe(false);
            expect(isPositiveInteger('abc')).toBe(false);
            expect(isPositiveInteger('')).toBe(false);
            expect(isPositiveInteger('1.5')).toBe(false);
        });
    });

    // --- safeReply ---
    describe('safeReply', () => {
        test('should call enqueueMessage and swallow errors', async () => {
            await safeReply('#ch', 'msg', { replyToId: '1' }, '[Test]');
            expect(enqueueMessage).toHaveBeenCalledWith('#ch', 'msg', { replyToId: '1' });
        });

        test('should catch and log enqueueMessage failures', async () => {
            enqueueMessage.mockRejectedValue(new Error('IRC down'));
            await safeReply('#ch', 'msg', { replyToId: '1' }, '[Test]');
            expect(logger.warn).toHaveBeenCalledWith(
                { err: expect.any(Error) },
                '[Test] Failed to send message to chat'
            );
        });
    });

    // --- extractGameContext ---
    describe('extractGameContext', () => {
        test('should extract all fields from handler context', () => {
            isPrivilegedUser.mockReturnValue(true);
            const context = {
                channel: '#mychannel',
                user: { username: 'bob', 'display-name': 'Bob', id: 'uid-1', mod: '1' },
                args: ['stop'],
            };

            const result = extractGameContext(context);

            expect(result).toEqual({
                channel: '#mychannel',
                channelName: 'mychannel',
                username: 'bob',
                displayName: 'Bob',
                replyToId: 'uid-1',
                isMod: true,
                args: ['stop'],
            });
        });

        test('should fall back to message-id for replyToId', () => {
            const context = {
                channel: '#ch',
                user: { username: 'u', 'display-name': 'U', 'message-id': 'mid-1' },
                args: [],
            };

            const result = extractGameContext(context);
            expect(result.replyToId).toBe('mid-1');
        });

        test('should use username as displayName fallback', () => {
            const context = {
                channel: '#ch',
                user: { username: 'fallback_user' },
                args: [],
            };

            const result = extractGameContext(context);
            expect(result.displayName).toBe('fallback_user');
        });

        test('should lowercase username defensively', () => {
            const context = {
                channel: '#ch',
                user: { username: 'MixedCaseUser', 'display-name': 'MixedCaseUser' },
                args: [],
            };

            const result = extractGameContext(context);
            expect(result.username).toBe('mixedcaseuser');
            // displayName should NOT be lowercased (it's for display)
            expect(result.displayName).toBe('MixedCaseUser');
        });
    });

    // --- handleStop ---
    describe('handleStop', () => {
        const createManager = (initiator = null) => ({
            getCurrentGameInitiator: jest.fn().mockReturnValue(initiator),
            stopGame: jest.fn().mockReturnValue({ message: 'Game stopped' }),
        });

        test('should report no active game when initiator is null', async () => {
            const manager = createManager(null);
            await handleStop(createGameCtx(), manager, 'Trivia');

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'There is no active Trivia to stop.',
                { replyToId: '123' }
            );
            expect(manager.stopGame).not.toHaveBeenCalled();
        });

        test('should avoid awkward phrasing when gameName contains Game', async () => {
            const manager = createManager(null);
            await handleStop(createGameCtx(), manager, 'Geo-Game');

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'There is no active Geo-Game to stop.',
                { replyToId: '123' }
            );
        });

        test('should stop game when user is the initiator', async () => {
            const manager = createManager('testuser');
            await handleStop(createGameCtx(), manager, 'Trivia');

            expect(manager.stopGame).toHaveBeenCalledWith('testchannel');
        });

        test('should stop game when user is a mod', async () => {
            const manager = createManager('otheruser');
            await handleStop(createGameCtx({ isMod: true }), manager, 'Trivia');

            expect(manager.stopGame).toHaveBeenCalledWith('testchannel');
        });

        test('should deny stop from non-initiator non-mod', async () => {
            const manager = createManager('otheruser');
            await handleStop(createGameCtx(), manager, 'Trivia');

            expect(manager.stopGame).not.toHaveBeenCalled();
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Only the game initiator, mods, or the broadcaster can stop the current game.',
                { replyToId: '123' }
            );
        });
    });

    // --- handleLeaderboard ---
    describe('handleLeaderboard', () => {
        test('should fetch, format, and send leaderboard', async () => {
            const mockData = [{ id: 'u1', data: { points: 100 } }];
            const getLeaderboardFn = jest.fn().mockResolvedValue(mockData);
            const formatFn = jest.fn().mockReturnValue('Formatted leaderboard');

            await handleLeaderboard(createGameCtx(), getLeaderboardFn, formatFn, 'Trivia');

            expect(getLeaderboardFn).toHaveBeenCalledWith('testchannel', 5);
            expect(formatFn).toHaveBeenCalledWith(mockData, 'testchannel');
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Formatted leaderboard',
                { replyToId: '123' }
            );
        });

        test('should handle fetch errors gracefully', async () => {
            const getLeaderboardFn = jest.fn().mockRejectedValue(new Error('DB error'));
            const formatFn = jest.fn();

            await handleLeaderboard(createGameCtx(), getLeaderboardFn, formatFn, 'Trivia');

            expect(logger.error).toHaveBeenCalled();
            // safeReply should send the fallback message
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                "Sorry, couldn't fetch the leaderboard right now.",
                { replyToId: '123' }
            );
        });
    });

    // --- handleClearLeaderboard ---
    describe('handleClearLeaderboard', () => {
        const createManager = () => ({
            clearLeaderboard: jest.fn().mockResolvedValue({ message: 'Cleared!' }),
        });

        test('should deny non-mods', async () => {
            await handleClearLeaderboard(createGameCtx(), createManager(), 'Trivia');

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Only mods or the broadcaster can clear the leaderboard.',
                { replyToId: '123' }
            );
        });

        test('should clear leaderboard for mods', async () => {
            const manager = createManager();
            await handleClearLeaderboard(createGameCtx({ isMod: true }), manager, 'Trivia');

            expect(manager.clearLeaderboard).toHaveBeenCalledWith('testchannel');
            // Should send the "Attempting..." message then the result
            expect(enqueueMessage).toHaveBeenCalledTimes(2);
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Cleared!',
                { replyToId: '123' }
            );
        });

        test('should handle clearLeaderboard errors', async () => {
            const manager = { clearLeaderboard: jest.fn().mockRejectedValue(new Error('fail')) };
            await handleClearLeaderboard(createGameCtx({ isMod: true }), manager, 'Trivia');

            expect(logger.error).toHaveBeenCalled();
        });
    });

    // --- handleResetConfig ---
    describe('handleResetConfig', () => {
        test('should deny non-mods', async () => {
            const manager = { resetChannelConfig: jest.fn() };
            await handleResetConfig(createGameCtx(), manager, 'Trivia');

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Only mods or the broadcaster can reset the game configuration.',
                { replyToId: '123' }
            );
            expect(manager.resetChannelConfig).not.toHaveBeenCalled();
        });

        test('should reset config for mods', async () => {
            const manager = { resetChannelConfig: jest.fn().mockResolvedValue({ message: 'Reset done' }) };
            await handleResetConfig(createGameCtx({ isMod: true }), manager, 'Trivia');

            expect(manager.resetChannelConfig).toHaveBeenCalledWith('testchannel');
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Reset done',
                { replyToId: '123' }
            );
        });
    });

    // --- handleReport ---
    describe('handleReport', () => {
        const createManager = () => ({
            initiateReportProcess: jest.fn().mockResolvedValue({ success: true, message: 'Report filed' }),
        });

        test('should require a reason', async () => {
            await handleReport(createGameCtx({ args: ['report'] }), createManager(), 'Trivia', 'trivia');

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Please provide a reason for reporting. Usage: !trivia report <your reason>',
                { replyToId: '123' }
            );
        });

        test('should use commandName (not gameName) in usage hint', async () => {
            await handleReport(createGameCtx({ args: ['report'] }), createManager(), 'Geo-Game', 'geo');

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Please provide a reason for reporting. Usage: !geo report <your reason>',
                { replyToId: '123' }
            );
        });

        test('should submit report with reason', async () => {
            const manager = createManager();
            await handleReport(createGameCtx({ args: ['report', 'wrong', 'answer'] }), manager, 'Trivia', 'trivia');

            expect(manager.initiateReportProcess).toHaveBeenCalledWith('testchannel', 'wrong answer', 'testuser');
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Report filed',
                { replyToId: '123' }
            );
        });

        test('should handle report failure without message', async () => {
            const manager = { initiateReportProcess: jest.fn().mockResolvedValue({ success: false }) };
            await handleReport(createGameCtx({ args: ['report', 'bad'] }), manager, 'Trivia', 'trivia');

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Could not process your report request at this time.',
                { replyToId: '123' }
            );
        });
    });

    // --- handleConfig ---
    describe('handleConfig', () => {
        const schema = [
            { keys: ['difficulty'], type: 'enum', optionName: 'difficulty', enumValues: ['easy', 'normal', 'hard'] },
            { keys: ['time', 'questiontime'], type: 'int', optionName: 'questionTimeSeconds' },
            { keys: ['scoring'], type: 'bool', optionName: 'scoreTracking' },
            { keys: ['topic', 'topics'], type: 'list', optionName: 'topicPreferences' },
        ];
        const usage = 'Usage: !trivia config ...';

        const createManager = () => ({
            configureGame: jest.fn().mockResolvedValue({ message: 'Config updated' }),
        });

        test('should deny non-mods', async () => {
            await handleConfig(createGameCtx({ args: ['config', 'difficulty', 'hard'] }), createManager(), schema, usage, 'Trivia');

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Only mods or the broadcaster can configure the game.',
                { replyToId: '123' }
            );
        });

        test('should show usage when no valid options parsed', async () => {
            const gameCtx = createGameCtx({ isMod: true, args: ['config'] });
            await handleConfig(gameCtx, createManager(), schema, usage, 'Trivia');

            expect(enqueueMessage).toHaveBeenCalledWith('#testchannel', usage, { replyToId: '123' });
        });

        test('should parse enum option', async () => {
            const manager = createManager();
            const gameCtx = createGameCtx({ isMod: true, args: ['config', 'difficulty', 'hard'] });
            await handleConfig(gameCtx, manager, schema, usage, 'Trivia');

            expect(manager.configureGame).toHaveBeenCalledWith('testchannel', { difficulty: 'hard' });
        });

        test('should reject invalid enum values', async () => {
            const manager = createManager();
            const gameCtx = createGameCtx({ isMod: true, args: ['config', 'difficulty', 'impossible'] });
            await handleConfig(gameCtx, manager, schema, usage, 'Trivia');

            // No valid options → shows usage
            expect(enqueueMessage).toHaveBeenCalledWith('#testchannel', usage, { replyToId: '123' });
            expect(manager.configureGame).not.toHaveBeenCalled();
        });

        test('should parse int option', async () => {
            const manager = createManager();
            const gameCtx = createGameCtx({ isMod: true, args: ['config', 'time', '30'] });
            await handleConfig(gameCtx, manager, schema, usage, 'Trivia');

            expect(manager.configureGame).toHaveBeenCalledWith('testchannel', { questionTimeSeconds: 30 });
        });

        test('should parse bool option', async () => {
            const manager = createManager();
            const gameCtx = createGameCtx({ isMod: true, args: ['config', 'scoring', 'true'] });
            await handleConfig(gameCtx, manager, schema, usage, 'Trivia');

            expect(manager.configureGame).toHaveBeenCalledWith('testchannel', { scoreTracking: true });
        });

        test('should parse list option', async () => {
            const manager = createManager();
            const gameCtx = createGameCtx({ isMod: true, args: ['config', 'topic', 'animals,science'] });
            await handleConfig(gameCtx, manager, schema, usage, 'Trivia');

            expect(manager.configureGame).toHaveBeenCalledWith('testchannel', { topicPreferences: ['animals', 'science'] });
        });

        test('should parse multiple options at once', async () => {
            const manager = createManager();
            const gameCtx = createGameCtx({ isMod: true, args: ['config', 'difficulty', 'easy', 'time', '20'] });
            await handleConfig(gameCtx, manager, schema, usage, 'Trivia');

            expect(manager.configureGame).toHaveBeenCalledWith('testchannel', {
                difficulty: 'easy',
                questionTimeSeconds: 20,
            });
        });

        test('should skip unknown keys gracefully', async () => {
            const manager = createManager();
            const gameCtx = createGameCtx({ isMod: true, args: ['config', 'unknownkey', 'value', 'difficulty', 'normal'] });
            await handleConfig(gameCtx, manager, schema, usage, 'Trivia');

            expect(manager.configureGame).toHaveBeenCalledWith('testchannel', { difficulty: 'normal' });
        });

        test('should accept alternative key aliases', async () => {
            const manager = createManager();
            const gameCtx = createGameCtx({ isMod: true, args: ['config', 'questiontime', '45'] });
            await handleConfig(gameCtx, manager, schema, usage, 'Trivia');

            expect(manager.configureGame).toHaveBeenCalledWith('testchannel', { questionTimeSeconds: 45 });
        });
    });

    // --- validateRounds ---
    describe('validateRounds', () => {
        test('should return rounds unchanged if within limit', async () => {
            const result = await validateRounds(createGameCtx(), 5, 10);
            expect(result).toBe(5);
            expect(enqueueMessage).not.toHaveBeenCalled();
        });

        test('should clamp and notify when exceeding max', async () => {
            const result = await validateRounds(createGameCtx(), 15, 10);
            expect(result).toBe(10);
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Maximum number of rounds is 10. Starting a 10-round game.',
                { replyToId: '123' }
            );
        });
    });

    // --- startGameWithErrorHandling ---
    describe('startGameWithErrorHandling', () => {
        test('should call startFn and do nothing on success', async () => {
            const startFn = jest.fn().mockResolvedValue({ success: true });
            await startGameWithErrorHandling(createGameCtx(), startFn, 'Trivia');

            expect(startFn).toHaveBeenCalled();
            expect(enqueueMessage).not.toHaveBeenCalled();
        });

        test('should send error message on start failure', async () => {
            const startFn = jest.fn().mockResolvedValue({ success: false, error: 'Game already active' });
            await startGameWithErrorHandling(createGameCtx(), startFn, 'Trivia');

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Game already active',
                { replyToId: '123' }
            );
        });

        test('should catch and safely report exceptions', async () => {
            const startFn = jest.fn().mockRejectedValue(new Error('crash'));
            await startGameWithErrorHandling(createGameCtx(), startFn, 'Trivia');

            expect(logger.error).toHaveBeenCalledWith(
                { err: expect.any(Error) },
                'Unhandled error starting Trivia game from command handler.'
            );
            // safeReply sends the fallback
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'An unexpected error occurred trying to start the game.',
                { replyToId: '123' }
            );
        });
    });
});
