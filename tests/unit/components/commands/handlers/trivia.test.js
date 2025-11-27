// tests/unit/components/commands/handlers/trivia.test.js

jest.mock('../../../../../src/lib/logger.js');
jest.mock('../../../../../src/lib/ircSender.js');
jest.mock('../../../../../src/components/trivia/triviaGameManager.js');
jest.mock('../../../../../src/components/trivia/triviaStorage.js');
jest.mock('../../../../../src/components/trivia/triviaMessageFormatter.js');

import triviaHandler from '../../../../../src/components/commands/handlers/trivia.js';
import { enqueueMessage } from '../../../../../src/lib/ircSender.js';
import { getTriviaGameManager } from '../../../../../src/components/trivia/triviaGameManager.js';
import { getLeaderboard } from '../../../../../src/components/trivia/triviaStorage.js';
import { formatHelpMessage } from '../../../../../src/components/trivia/triviaMessageFormatter.js';

describe('Trivia Command Handler', () => {
    let mockTriviaManager;

    const createMockContext = (args = [], channel = '#testchannel', user = { username: 'testuser', 'display-name': 'TestUser', id: '123', mod: '0' }) => ({
        channel,
        user,
        args,
        message: `!trivia ${args.join(' ')}`,
        ircClient: {},
        contextManager: {}
    });

    beforeEach(() => {
        jest.clearAllMocks();

        mockTriviaManager = {
            startGame: jest.fn().mockResolvedValue({ success: true }),
            stopGame: jest.fn().mockReturnValue({ message: 'Game stopped' }),
            getCurrentGameInitiator: jest.fn().mockReturnValue(null),
            configureGame: jest.fn().mockResolvedValue({ message: 'Configuration updated' }),
            resetChannelConfig: jest.fn().mockResolvedValue({ message: 'Config reset' }),
            clearLeaderboard: jest.fn().mockResolvedValue({ message: 'Leaderboard cleared' }),
            initiateReportProcess: jest.fn().mockResolvedValue({ success: true, message: 'Report initiated' })
        };
        getTriviaGameManager.mockReturnValue(mockTriviaManager);

        enqueueMessage.mockResolvedValue();
        getLeaderboard.mockResolvedValue([]);
        formatHelpMessage.mockReturnValue('Trivia help message');
    });

    describe('Command Info', () => {
        test('should have correct command metadata', () => {
            expect(triviaHandler.name).toBe('trivia');
            expect(triviaHandler.description).toContain('Starts or manages a Trivia game');
            expect(triviaHandler.permission).toBe('everyone');
        });
    });

    describe('Starting Games', () => {
        test('should start default game with no arguments', async () => {
            const context = createMockContext([]);
            await triviaHandler.execute(context);

            expect(mockTriviaManager.startGame).toHaveBeenCalledWith(
                'testchannel',
                null,
                'testuser',
                1
            );
        });

        test('should start game with specified rounds', async () => {
            const context = createMockContext(['5']);
            await triviaHandler.execute(context);

            expect(mockTriviaManager.startGame).toHaveBeenCalledWith(
                'testchannel',
                null,
                'testuser',
                5
            );
        });

        test('should start game with topic', async () => {
            const context = createMockContext(['science']);
            await triviaHandler.execute(context);

            expect(mockTriviaManager.startGame).toHaveBeenCalledWith(
                'testchannel',
                'science',
                'testuser',
                1
            );
        });

        test('should start game with topic and rounds', async () => {
            const context = createMockContext(['science', '3']);
            await triviaHandler.execute(context);

            expect(mockTriviaManager.startGame).toHaveBeenCalledWith(
                'testchannel',
                'science',
                'testuser',
                3
            );
        });

        test('should start game based on current stream game', async () => {
            const context = createMockContext(['game']);
            await triviaHandler.execute(context);

            expect(mockTriviaManager.startGame).toHaveBeenCalledWith(
                'testchannel',
                'game',
                'testuser',
                1
            );
        });

        test('should handle game start failure', async () => {
            mockTriviaManager.startGame.mockResolvedValue({
                success: false,
                error: 'A game is already active'
            });
            const context = createMockContext([]);

            await triviaHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'A game is already active',
                { replyToId: '123' }
            );
        });

        test('should cap rounds at maximum', async () => {
            const context = createMockContext(['15']);
            await triviaHandler.execute(context);

            expect(mockTriviaManager.startGame).toHaveBeenCalledWith(
                'testchannel',
                null,
                'testuser',
                10
            );
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Maximum number of rounds is 10. Starting a 10-round game.',
                { replyToId: '123' }
            );
        });
    });

    describe('Stopping Games', () => {
        test('should stop game when initiator requests', async () => {
            mockTriviaManager.getCurrentGameInitiator.mockReturnValue('testuser');
            const context = createMockContext(['stop']);

            await triviaHandler.execute(context);

            expect(mockTriviaManager.stopGame).toHaveBeenCalledWith('testchannel');
        });

        test('should stop game when mod requests', async () => {
            mockTriviaManager.getCurrentGameInitiator.mockReturnValue('otheruser');
            const context = createMockContext(['stop'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '123',
                mod: '1'
            });

            await triviaHandler.execute(context);

            expect(mockTriviaManager.stopGame).toHaveBeenCalledWith('testchannel');
        });

        test('should reject stop from non-initiator non-mod', async () => {
            mockTriviaManager.getCurrentGameInitiator.mockReturnValue('otheruser');
            const context = createMockContext(['stop']);

            await triviaHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Only the game initiator, mods, or the broadcaster can stop the current game.',
                { replyToId: '123' }
            );
            expect(mockTriviaManager.stopGame).not.toHaveBeenCalled();
        });

        test('should handle no active game', async () => {
            mockTriviaManager.getCurrentGameInitiator.mockReturnValue(null);
            const context = createMockContext(['stop']);

            await triviaHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'There is no active Trivia game to stop.',
                { replyToId: '123' }
            );
        });
    });

    describe('Configuration', () => {
        test('should configure game settings as mod', async () => {
            const context = createMockContext(['config', 'difficulty', 'hard'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '123',
                mod: '1'
            });

            await triviaHandler.execute(context);

            expect(mockTriviaManager.configureGame).toHaveBeenCalledWith(
                'testchannel',
                { difficulty: 'hard' }
            );
        });

        test('should reject configuration from non-mod', async () => {
            const context = createMockContext(['config', 'difficulty', 'hard']);

            await triviaHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Only mods or the broadcaster can configure the game.',
                { replyToId: '123' }
            );
        });

        test('should reset configuration as mod', async () => {
            const context = createMockContext(['resetconfig'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '123',
                mod: '1'
            });

            await triviaHandler.execute(context);

            expect(mockTriviaManager.resetChannelConfig).toHaveBeenCalledWith('testchannel');
        });
    });

    describe('Leaderboard', () => {
        test('should display leaderboard', async () => {
            const leaderboardData = [
                { id: 'user1', data: { channelPoints: 100, channelCorrect: 10 } },
                { id: 'user2', data: { channelPoints: 50, channelCorrect: 5 } }
            ];
            getLeaderboard.mockResolvedValue(leaderboardData);

            const context = createMockContext(['leaderboard']);
            await triviaHandler.execute(context);

            expect(getLeaderboard).toHaveBeenCalledWith('testchannel', 5);
            expect(enqueueMessage).toHaveBeenCalled();
        });

        test('should clear leaderboard as mod', async () => {
            const context = createMockContext(['clearleaderboard'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '123',
                mod: '1'
            });

            await triviaHandler.execute(context);

            expect(mockTriviaManager.clearLeaderboard).toHaveBeenCalledWith('testchannel');
        });
    });

    describe('Help', () => {
        test('should display help message', async () => {
            const context = createMockContext(['help']);
            await triviaHandler.execute(context);

            expect(formatHelpMessage).toHaveBeenCalledWith(false);
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Trivia help message',
                { replyToId: '123' }
            );
        });
    });

    describe('Reporting', () => {
        test('should initiate report process', async () => {
            const context = createMockContext(['report', 'incorrect', 'answer']);

            await triviaHandler.execute(context);

            expect(mockTriviaManager.initiateReportProcess).toHaveBeenCalledWith(
                'testchannel',
                'incorrect answer',
                'testuser'
            );
        });

        test('should require reason for report', async () => {
            const context = createMockContext(['report']);

            await triviaHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Please provide a reason for reporting. Usage: !trivia report <your reason>',
                { replyToId: '123' }
            );
        });
    });
});

