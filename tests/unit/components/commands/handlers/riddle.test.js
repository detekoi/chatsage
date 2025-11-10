// tests/unit/components/commands/handlers/riddle.test.js

jest.mock('../../../../../src/lib/logger.js');
jest.mock('../../../../../src/lib/ircSender.js');
jest.mock('../../../../../src/components/riddle/riddleGameManager.js');
jest.mock('../../../../../src/components/riddle/riddleStorage.js');
jest.mock('../../../../../src/components/riddle/riddleMessageFormatter.js');
jest.mock('../../../../../src/config/index.js');

import riddleHandler from '../../../../../src/components/commands/handlers/riddle.js';
import { enqueueMessage } from '../../../../../src/lib/ircSender.js';
import { getRiddleGameManager } from '../../../../../src/components/riddle/riddleGameManager.js';
import { getLeaderboard } from '../../../../../src/components/riddle/riddleStorage.js';
import { formatRiddleHelpMessage, formatRiddleLeaderboardMessage } from '../../../../../src/components/riddle/riddleMessageFormatter.js';
import config from '../../../../../src/config/index.js';
import logger from '../../../../../src/lib/logger.js';

describe('Riddle Command Handler', () => {
    let mockRiddleManager;

    const createMockContext = (args = [], channel = '#testchannel', user = { username: 'testuser', 'display-name': 'TestUser', id: '123', mod: '0' }) => ({
        channel,
        user,
        args,
        message: `!riddle ${args.join(' ')}`,
        ircClient: {},
        contextManager: {}
    });

    beforeEach(() => {
        jest.clearAllMocks();

        config.twitch = { username: 'testbot' };

        mockRiddleManager = {
            startGame: jest.fn().mockResolvedValue({ success: true }),
            stopGame: jest.fn().mockReturnValue({ message: 'Game stopped' }),
            getCurrentGameInitiator: jest.fn().mockReturnValue(null),
            clearLeaderboard: jest.fn().mockResolvedValue({ message: 'Leaderboard cleared' }),
            initiateReportProcess: jest.fn().mockResolvedValue({ success: true, message: 'Report initiated' })
        };
        getRiddleGameManager.mockReturnValue(mockRiddleManager);

        enqueueMessage.mockResolvedValue();
        getLeaderboard.mockResolvedValue([]);
        formatRiddleHelpMessage.mockReturnValue('Riddle help message');
        formatRiddleLeaderboardMessage.mockReturnValue('Leaderboard message');
    });

    describe('Command Info', () => {
        test('should have correct command metadata', () => {
            expect(riddleHandler.name).toBe('riddle');
            expect(riddleHandler.description).toContain('Starts or manages a Riddle game');
            expect(riddleHandler.permission).toBe('everyone');
        });
    });

    describe('Starting Games', () => {
        test('should start default game with no arguments', async () => {
            const context = createMockContext([]);
            await riddleHandler.execute(context);

            expect(mockRiddleManager.startGame).toHaveBeenCalledWith(
                'testchannel',
                null,
                'testuser',
                1
            );
        });

        test('should start game with specified rounds', async () => {
            const context = createMockContext(['5']);
            await riddleHandler.execute(context);

            expect(mockRiddleManager.startGame).toHaveBeenCalledWith(
                'testchannel',
                null,
                'testuser',
                5
            );
        });

        test('should start game with subject', async () => {
            const context = createMockContext(['animals']);
            await riddleHandler.execute(context);

            expect(mockRiddleManager.startGame).toHaveBeenCalledWith(
                'testchannel',
                'animals',
                'testuser',
                1
            );
        });

        test('should start game with subject and rounds', async () => {
            const context = createMockContext(['animals', '3']);
            await riddleHandler.execute(context);

            expect(mockRiddleManager.startGame).toHaveBeenCalledWith(
                'testchannel',
                'animals',
                'testuser',
                3
            );
        });

        test('should handle multi-word subjects', async () => {
            const context = createMockContext(['science', 'fiction', '2']);
            await riddleHandler.execute(context);

            expect(mockRiddleManager.startGame).toHaveBeenCalledWith(
                'testchannel',
                'science fiction',
                'testuser',
                2
            );
        });

        test('should handle game start failure', async () => {
            mockRiddleManager.startGame.mockResolvedValue({
                success: false,
                error: 'A game is already active'
            });
            const context = createMockContext([]);

            await riddleHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'A game is already active',
                { replyToId: '123' }
            );
        });

        test('should clean quotes from topic', async () => {
            const context = createMockContext(['"animals"']);
            await riddleHandler.execute(context);

            expect(mockRiddleManager.startGame).toHaveBeenCalledWith(
                'testchannel',
                'animals',
                'testuser',
                1
            );
        });
    });

    describe('Stopping Games', () => {
        test('should stop game when initiator requests', async () => {
            mockRiddleManager.getCurrentGameInitiator.mockReturnValue('testuser');
            const context = createMockContext(['stop']);

            await riddleHandler.execute(context);

            expect(mockRiddleManager.stopGame).toHaveBeenCalledWith('testchannel');
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Game stopped',
                { replyToId: '123' }
            );
        });

        test('should stop game when mod requests', async () => {
            mockRiddleManager.getCurrentGameInitiator.mockReturnValue('otheruser');
            const context = createMockContext(['stop'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '123',
                mod: '1'
            });

            await riddleHandler.execute(context);

            expect(mockRiddleManager.stopGame).toHaveBeenCalledWith('testchannel');
        });

        test('should reject stop from non-initiator non-mod', async () => {
            mockRiddleManager.getCurrentGameInitiator.mockReturnValue('otheruser');
            const context = createMockContext(['stop']);

            await riddleHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Only the game initiator, mods, or the broadcaster can stop the riddle game.',
                { replyToId: '123' }
            );
        });

        test('should prevent stopping bot itself', async () => {
            mockRiddleManager.getCurrentGameInitiator.mockReturnValue('testuser');
            const context = createMockContext(['stop', 'testbot']);

            await riddleHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'I can\'t stop myself!',
                { replyToId: '123' }
            );
            expect(mockRiddleManager.stopGame).not.toHaveBeenCalled();
        });
    });

    describe('Leaderboard', () => {
        test('should display leaderboard', async () => {
            const leaderboardData = [
                { id: 'user1', data: { points: 100 } }
            ];
            getLeaderboard.mockResolvedValue(leaderboardData);

            const context = createMockContext(['leaderboard']);
            await riddleHandler.execute(context);

            expect(getLeaderboard).toHaveBeenCalledWith('testchannel', 5);
            expect(formatRiddleLeaderboardMessage).toHaveBeenCalledWith(leaderboardData, 'testchannel');
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Leaderboard message',
                { replyToId: '123' }
            );
        });

        test('should clear leaderboard as mod', async () => {
            const context = createMockContext(['clearleaderboard'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '123',
                mod: '1'
            });

            await riddleHandler.execute(context);

            expect(mockRiddleManager.clearLeaderboard).toHaveBeenCalledWith('testchannel');
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Leaderboard cleared',
                { replyToId: '123' }
            );
        });

        test('should reject clear leaderboard from non-mod', async () => {
            const context = createMockContext(['clearleaderboard']);

            await riddleHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Only mods or the broadcaster can clear the riddle leaderboard.',
                { replyToId: '123' }
            );
        });
    });

    describe('Help', () => {
        test('should display help message', async () => {
            const context = createMockContext(['help']);
            await riddleHandler.execute(context);

            expect(formatRiddleHelpMessage).toHaveBeenCalledWith(false);
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Riddle help message',
                { replyToId: '123' }
            );
        });

        test('should show mod-specific help for mods', async () => {
            const context = createMockContext(['help'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '123',
                mod: '1'
            });

            await riddleHandler.execute(context);

            expect(formatRiddleHelpMessage).toHaveBeenCalledWith(true);
        });
    });

    describe('Reporting', () => {
        test('should initiate report process', async () => {
            const context = createMockContext(['report', 'incorrect', 'answer']);

            await riddleHandler.execute(context);

            expect(mockRiddleManager.initiateReportProcess).toHaveBeenCalledWith(
                'testchannel',
                'incorrect answer',
                'testuser'
            );
        });

        test('should require reason for report', async () => {
            const context = createMockContext(['report']);

            await riddleHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Please provide a reason for reporting. Usage: !riddle report <your reason>',
                { replyToId: '123' }
            );
        });
    });
});

