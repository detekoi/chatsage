// tests/unit/components/commands/handlers/help.test.js

jest.mock('../../../../../src/lib/logger.js');
jest.mock('../../../../../src/lib/ircSender.js');

import helpHandler from '../../../../../src/components/commands/handlers/help.js';
import { enqueueMessage } from '../../../../../src/lib/ircSender.js';
import logger from '../../../../../src/lib/logger.js';

describe('Help Command Handler', () => {
    const createMockContext = (channel = '#testchannel', user = { username: 'testuser', 'display-name': 'TestUser', id: '123' }) => ({
        channel,
        user,
        args: [],
        message: '!help',
        ircClient: {},
        contextManager: {}
    });

    beforeEach(() => {
        jest.clearAllMocks();
        enqueueMessage.mockResolvedValue();
    });

    describe('Command Info', () => {
        test('should have correct command metadata', () => {
            expect(helpHandler.name).toBe('help');
            expect(helpHandler.description).toContain('Shows where to find the list of available commands');
            expect(helpHandler.usage).toBe('!help or !commands');
            expect(helpHandler.permission).toBe('everyone');
        });
    });

    describe('Command Execution', () => {
        test('should send help URL message', async () => {
            const context = createMockContext();
            await helpHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'You can find my command list here: https://docs.wildcat.chat/botcommands.html',
                { replyToId: '123' }
            );
        });

        test('should use user.id for replyToId', async () => {
            const context = createMockContext('#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: 'user-id-456'
            });
            await helpHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.any(String),
                { replyToId: 'user-id-456' }
            );
        });

        test('should fallback to message-id if user.id not available', async () => {
            const context = createMockContext('#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                'message-id': 'msg-789'
            });
            await helpHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.any(String),
                { replyToId: 'msg-789' }
            );
        });

        test('should use null replyToId if neither id nor message-id available', async () => {
            const context = createMockContext('#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser'
            });
            await helpHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.any(String),
                { replyToId: null }
            );
        });

        test('should log execution', async () => {
            const context = createMockContext();
            await helpHandler.execute(context);

            expect(logger.info).toHaveBeenCalledWith(
                'Executed !help command in #testchannel for testuser'
            );
        });

        test('should call enqueueMessage successfully', async () => {
            const context = createMockContext();
            await helpHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'You can find my command list here: https://docs.wildcat.chat/botcommands.html',
                { replyToId: '123' }
            );
        });
    });
});

