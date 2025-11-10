// tests/unit/components/commands/handlers/geo.test.js

jest.mock('../../../../../src/lib/logger.js');
jest.mock('../../../../../src/lib/ircSender.js');
jest.mock('../../../../../src/components/geo/geoGameManager.js');
jest.mock('../../../../../src/components/geo/geoStorage.js');
jest.mock('../../../../../src/components/context/contextManager.js');

import geoHandler from '../../../../../src/components/commands/handlers/geo.js';
import { enqueueMessage } from '../../../../../src/lib/ircSender.js';
import { getGeoGameManager } from '../../../../../src/components/geo/geoGameManager.js';
import { getLeaderboard } from '../../../../../src/components/geo/geoStorage.js';
import { getContextManager } from '../../../../../src/components/context/contextManager.js';
import logger from '../../../../../src/lib/logger.js';

describe('Geo Command Handler', () => {
    let mockGeoManager;
    let mockContextManager;

    const createMockContext = (args = [], channel = '#testchannel', user = { username: 'testuser', 'display-name': 'TestUser', id: '123', mod: '0' }) => ({
        channel,
        user,
        args,
        message: `!geo ${args.join(' ')}`,
        ircClient: {},
        contextManager: mockContextManager
    });

    beforeEach(() => {
        jest.clearAllMocks();

        mockGeoManager = {
            startGame: jest.fn().mockResolvedValue({ success: true }),
            stopGame: jest.fn(),
            getCurrentGameInitiator: jest.fn().mockReturnValue(null),
            configureGame: jest.fn().mockResolvedValue({ message: 'Configuration updated' }),
            resetChannelConfig: jest.fn().mockResolvedValue({ message: 'Config reset' }),
            clearLeaderboard: jest.fn().mockResolvedValue({ message: 'Leaderboard cleared' }),
            initiateReportProcess: jest.fn().mockResolvedValue({ success: true, message: 'Report initiated' })
        };
        getGeoGameManager.mockReturnValue(mockGeoManager);

        mockContextManager = {
            getContextForLLM: jest.fn().mockReturnValue({ streamGame: 'Test Game' })
        };
        getContextManager.mockReturnValue(mockContextManager);

        enqueueMessage.mockResolvedValue();
        getLeaderboard.mockResolvedValue([]);
    });

    describe('Command Info', () => {
        test('should have correct command metadata', () => {
            expect(geoHandler.name).toBe('geo');
            expect(geoHandler.description).toContain('Starts or manages the Geo-Game');
            expect(geoHandler.permission).toBe('everyone');
        });
    });

    describe('Starting Games', () => {
        test('should start default real world game with no arguments', async () => {
            const context = createMockContext([]);
            await geoHandler.execute(context);

            expect(mockGeoManager.startGame).toHaveBeenCalledWith(
                'testchannel',
                'real',
                null,
                'testuser',
                1
            );
        });

        test('should start game with specified rounds', async () => {
            const context = createMockContext(['5']);
            await geoHandler.execute(context);

            expect(mockGeoManager.startGame).toHaveBeenCalledWith(
                'testchannel',
                'real',
                null,
                'testuser',
                5
            );
        });

        test('should start game with region scope', async () => {
            const context = createMockContext(['europe']);
            await geoHandler.execute(context);

            expect(mockGeoManager.startGame).toHaveBeenCalledWith(
                'testchannel',
                'real',
                'europe',
                'testuser',
                1
            );
        });

        test('should start game mode with current stream game', async () => {
            const context = createMockContext(['game']);
            await geoHandler.execute(context);

            expect(mockContextManager.getContextForLLM).toHaveBeenCalled();
            expect(mockGeoManager.startGame).toHaveBeenCalledWith(
                'testchannel',
                'game',
                'Test Game',
                'testuser',
                1
            );
        });

        test('should start game mode with specified title', async () => {
            const context = createMockContext(['game', 'Minecraft', '3']);
            await geoHandler.execute(context);

            expect(mockGeoManager.startGame).toHaveBeenCalledWith(
                'testchannel',
                'game',
                'Minecraft',
                'testuser',
                3
            );
        });

        test('should handle game start failure', async () => {
            mockGeoManager.startGame.mockResolvedValue({
                success: false,
                error: 'A game is already active'
            });
            const context = createMockContext([]);

            await geoHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'A game is already active',
                { replyToId: '123' }
            );
        });

        test('should cap rounds at maximum', async () => {
            const context = createMockContext(['15']);
            await geoHandler.execute(context);

            expect(mockGeoManager.startGame).toHaveBeenCalledWith(
                'testchannel',
                'real',
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
            mockGeoManager.getCurrentGameInitiator.mockReturnValue('testuser');
            const context = createMockContext(['stop']);

            await geoHandler.execute(context);

            expect(mockGeoManager.stopGame).toHaveBeenCalledWith('testchannel');
        });

        test('should stop game when mod requests', async () => {
            mockGeoManager.getCurrentGameInitiator.mockReturnValue('otheruser');
            const context = createMockContext(['stop'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '123',
                mod: '1'
            });

            await geoHandler.execute(context);

            expect(mockGeoManager.stopGame).toHaveBeenCalledWith('testchannel');
        });

        test('should reject stop from non-initiator non-mod', async () => {
            mockGeoManager.getCurrentGameInitiator.mockReturnValue('otheruser');
            const context = createMockContext(['stop']);

            await geoHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Only the game initiator, mods, or the broadcaster can stop the current game.',
                { replyToId: '123' }
            );
        });

        test('should handle no active game', async () => {
            mockGeoManager.getCurrentGameInitiator.mockReturnValue(null);
            const context = createMockContext(['stop']);

            await geoHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'There is no active Geo-Game round to stop.',
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

            await geoHandler.execute(context);

            expect(mockGeoManager.configureGame).toHaveBeenCalledWith(
                'testchannel',
                { difficulty: 'hard' }
            );
        });

        test('should reject configuration from non-mod', async () => {
            const context = createMockContext(['config', 'difficulty', 'hard']);

            await geoHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Only mods or the broadcaster can configure the game.',
                { replyToId: '123' }
            );
        });
    });

    describe('Leaderboard', () => {
        test('should display leaderboard', async () => {
            const leaderboardData = [
                { id: 'user1', data: { channelPoints: 100, channelWins: 5 } }
            ];
            getLeaderboard.mockResolvedValue(leaderboardData);

            const context = createMockContext(['leaderboard']);
            await geoHandler.execute(context);

            expect(getLeaderboard).toHaveBeenCalledWith('testchannel', 5);
            expect(enqueueMessage).toHaveBeenCalled();
        });
    });

    describe('Help', () => {
        test('should display help message', async () => {
            const context = createMockContext(['help']);
            await geoHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('Geo-Game:'),
                { replyToId: '123' }
            );
        });
    });
});

