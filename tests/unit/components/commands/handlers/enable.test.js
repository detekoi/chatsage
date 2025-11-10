// tests/unit/components/commands/handlers/enable.test.js

jest.mock('../../../../../src/components/context/commandStateManager.js');
jest.mock('../../../../../src/components/commands/handlers/index.js');
jest.mock('../../../../../src/lib/logger.js');

import enableHandler from '../../../../../src/components/commands/handlers/enable.js';
import { enableCommandForChannel, isValidCommand, getAllAvailableCommands } from '../../../../../src/components/context/commandStateManager.js';
import commandHandlers from '../../../../../src/components/commands/handlers/index.js';
import logger from '../../../../../src/lib/logger.js';

describe('Enable Command Handler', () => {
    let mockIrcClient;

    const createMockContext = (args = [], channel = '#testchannel', user = { username: 'testuser', 'display-name': 'TestUser', id: '123' }) => ({
        channel,
        user,
        args,
        message: `!enable ${args.join(' ')}`,
        ircClient: mockIrcClient,
        contextManager: {},
        logger
    });

    beforeEach(() => {
        jest.clearAllMocks();
        
        mockIrcClient = {
            say: jest.fn().mockResolvedValue()
        };

        isValidCommand.mockReturnValue(true);
        getAllAvailableCommands.mockReturnValue(['trivia', 'geo', 'riddle', 'ask']);
        enableCommandForChannel.mockResolvedValue({ success: true, message: 'Command enabled successfully' });
    });

    describe('Command Info', () => {
        test('should have correct permission', () => {
            expect(enableHandler.permission).toBe('moderator');
            expect(enableHandler.description).toContain('Enables a previously disabled command');
        });
    });

    describe('Command Execution', () => {
        test('should show usage when no command name provided', async () => {
            const context = createMockContext([]);
            await enableHandler.execute(context);

            expect(mockIrcClient.say).toHaveBeenCalledWith(
                '#testchannel',
                'Usage: !enable <commandName>. Example: !enable trivia'
            );
            expect(enableCommandForChannel).not.toHaveBeenCalled();
        });

        test('should enable command successfully', async () => {
            const context = createMockContext(['trivia']);
            await enableHandler.execute(context);

            expect(isValidCommand).toHaveBeenCalledWith('trivia', commandHandlers);
            expect(enableCommandForChannel).toHaveBeenCalledWith('testchannel', 'trivia');
            expect(mockIrcClient.say).toHaveBeenCalledWith(
                '#testchannel',
                'Command enabled successfully'
            );
            expect(logger.info).toHaveBeenCalledWith(
                '[EnableCommand] Successfully enabled command \'trivia\' in channel testchannel by testuser'
            );
        });

        test('should handle command name case insensitivity', async () => {
            const context = createMockContext(['TRIVIA']);
            await enableHandler.execute(context);

            expect(enableCommandForChannel).toHaveBeenCalledWith('testchannel', 'trivia');
        });

        test('should reject unknown command', async () => {
            isValidCommand.mockReturnValue(false);
            const context = createMockContext(['unknowncommand']);

            await enableHandler.execute(context);

            expect(mockIrcClient.say).toHaveBeenCalledWith(
                '#testchannel',
                'Unknown command \'unknowncommand\'. Available commands: trivia, geo, riddle, ask'
            );
            expect(enableCommandForChannel).not.toHaveBeenCalled();
        });

        test('should handle enable failure', async () => {
            enableCommandForChannel.mockResolvedValue({
                success: false,
                message: 'Command was already enabled'
            });
            const context = createMockContext(['trivia']);

            await enableHandler.execute(context);

            expect(mockIrcClient.say).toHaveBeenCalledWith(
                '#testchannel',
                'Command was already enabled'
            );
            expect(logger.warn).toHaveBeenCalledWith(
                '[EnableCommand] Failed to enable command \'trivia\' in channel testchannel: Command was already enabled'
            );
        });

        test('should handle errors during enable', async () => {
            const error = new Error('Database error');
            enableCommandForChannel.mockRejectedValue(error);
            const context = createMockContext(['trivia']);

            await enableHandler.execute(context);

            expect(logger.error).toHaveBeenCalledWith(
                { err: error, channel: 'testchannel', user: 'testuser', command: 'trivia' },
                '[EnableCommand] Error enabling command \'trivia\' in channel testchannel'
            );
            expect(mockIrcClient.say).toHaveBeenCalledWith(
                '#testchannel',
                'Sorry, there was an error enabling the command. Please try again later.'
            );
        });

        test('should remove # prefix from channel name', async () => {
            const context = createMockContext(['trivia'], '#anotherchannel');
            await enableHandler.execute(context);

            expect(enableCommandForChannel).toHaveBeenCalledWith('anotherchannel', 'trivia');
        });
    });
});

