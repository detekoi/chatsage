// tests/unit/components/commands/handlers/disable.test.js

jest.mock('../../../../../src/components/context/commandStateManager.js');
jest.mock('../../../../../src/components/commands/handlers/index.js');
jest.mock('../../../../../src/lib/logger.js');
jest.mock('../../../../../src/lib/ircSender.js');

import disableHandler from '../../../../../src/components/commands/handlers/disable.js';
import { disableCommandForChannel, isValidCommand, getAllAvailableCommands } from '../../../../../src/components/context/commandStateManager.js';
import { enqueueMessage } from '../../../../../src/lib/ircSender.js';
import commandHandlers from '../../../../../src/components/commands/handlers/index.js';
import logger from '../../../../../src/lib/logger.js';

describe('Disable Command Handler', () => {
    const createMockContext = (args = [], channel = '#testchannel', user = { username: 'testuser', 'display-name': 'TestUser', id: '123' }) => ({
        channel,
        user,
        args,
        message: `!disable ${args.join(' ')}`,
        ircClient: {},
        contextManager: {},
        logger
    });

    beforeEach(() => {
        jest.clearAllMocks();
        
        isValidCommand.mockReturnValue(true);
        getAllAvailableCommands.mockReturnValue(['trivia', 'geo', 'riddle', 'ask']);
        disableCommandForChannel.mockResolvedValue({ success: true, message: 'Command disabled successfully' });
        enqueueMessage.mockResolvedValue();
    });

    describe('Command Info', () => {
        test('should have correct permission', () => {
            expect(disableHandler.permission).toBe('moderator');
            expect(disableHandler.description).toContain('Disables a command');
        });
    });

    describe('Command Execution', () => {
        test('should show usage when no command name provided', async () => {
            const context = createMockContext([]);
            await disableHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Usage: !disable <commandName>. Example: !disable trivia',
                { replyToId: '123' }
            );
            expect(disableCommandForChannel).not.toHaveBeenCalled();
        });

        test('should disable command successfully', async () => {
            const context = createMockContext(['trivia']);
            await disableHandler.execute(context);

            expect(isValidCommand).toHaveBeenCalledWith('trivia', commandHandlers);
            expect(disableCommandForChannel).toHaveBeenCalledWith('testchannel', 'trivia');
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Command disabled successfully',
                { replyToId: '123' }
            );
            expect(logger.info).toHaveBeenCalledWith(
                '[DisableCommand] Successfully disabled command \'trivia\' in channel testchannel by testuser'
            );
        });

        test('should handle command name case insensitivity', async () => {
            const context = createMockContext(['TRIVIA']);
            await disableHandler.execute(context);

            expect(disableCommandForChannel).toHaveBeenCalledWith('testchannel', 'trivia');
        });

        test('should reject unknown command', async () => {
            isValidCommand.mockReturnValue(false);
            const context = createMockContext(['unknowncommand']);

            await disableHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Unknown command \'unknowncommand\'. Available commands: trivia, geo, riddle, ask',
                { replyToId: '123' }
            );
            expect(disableCommandForChannel).not.toHaveBeenCalled();
        });

        test('should handle disable failure', async () => {
            disableCommandForChannel.mockResolvedValue({
                success: false,
                message: 'Command was already disabled'
            });
            const context = createMockContext(['trivia']);

            await disableHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Command was already disabled',
                { replyToId: '123' }
            );
            expect(logger.warn).toHaveBeenCalledWith(
                '[DisableCommand] Failed to disable command \'trivia\' in channel testchannel: Command was already disabled'
            );
        });

        test('should handle errors during disable', async () => {
            const error = new Error('Database error');
            disableCommandForChannel.mockRejectedValue(error);
            const context = createMockContext(['trivia']);

            await disableHandler.execute(context);

            expect(logger.error).toHaveBeenCalledWith(
                { err: error, channel: 'testchannel', user: 'testuser', command: 'trivia' },
                '[DisableCommand] Error disabling command \'trivia\' in channel testchannel'
            );
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Sorry, there was an error disabling the command. Please try again later.',
                { replyToId: '123' }
            );
        });

        test('should remove # prefix from channel name', async () => {
            const context = createMockContext(['trivia'], '#anotherchannel');
            await disableHandler.execute(context);

            expect(disableCommandForChannel).toHaveBeenCalledWith('anotherchannel', 'trivia');
        });

        test('should use message-id as fallback for replyToId', async () => {
            const context = createMockContext(['trivia'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                'message-id': 'msg-456'
            });
            await disableHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.any(String),
                { replyToId: 'msg-456' }
            );
        });

        test('should use null replyToId if neither id nor message-id available', async () => {
            const context = createMockContext(['trivia'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser'
            });
            await disableHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.any(String),
                { replyToId: null }
            );
        });
    });
});

