// tests/unit/components/commands/handlers/ping.test.js

jest.mock('../../../../../src/lib/logger.js');
jest.mock('../../../../../src/lib/ircSender.js');

import pingHandler from '../../../../../src/components/commands/handlers/ping.js';
import { enqueueMessage } from '../../../../../src/lib/ircSender.js';
import logger from '../../../../../src/lib/logger.js';

describe('Ping Command Handler', () => {
    const createMockContext = (channel = '#testchannel', user = { username: 'testuser', 'display-name': 'TestUser', id: '123' }) => ({
        channel,
        user,
        args: [],
        message: '!ping',
        ircClient: {},
        contextManager: {}
    });

    beforeEach(() => {
        jest.clearAllMocks();
        enqueueMessage.mockResolvedValue();
    });

    describe('Command Info', () => {
        test('should have correct command metadata', () => {
            expect(pingHandler.name).toBe('ping');
            expect(pingHandler.description).toContain('Checks if the bot is responsive');
            expect(pingHandler.usage).toBe('!ping');
            expect(pingHandler.permission).toBe('everyone');
        });
    });

    describe('Command Execution', () => {
        test('should send "Pong!" response', async () => {
            const context = createMockContext();
            await pingHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Pong!',
                { replyToId: '123' }
            );
        });

        test('should use user.id for replyToId', async () => {
            const context = createMockContext('#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: 'user-id-456'
            });
            await pingHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Pong!',
                { replyToId: 'user-id-456' }
            );
        });

        test('should fallback to message-id if user.id not available', async () => {
            const context = createMockContext('#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                'message-id': 'msg-789'
            });
            await pingHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Pong!',
                { replyToId: 'msg-789' }
            );
        });

        test('should use null replyToId if neither id nor message-id available', async () => {
            const context = createMockContext('#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser'
            });
            await pingHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Pong!',
                { replyToId: null }
            );
        });

        test('should log execution', async () => {
            const context = createMockContext();
            await pingHandler.execute(context);

            expect(logger.info).toHaveBeenCalledWith(
                { channel: '#testchannel', user: 'testuser' },
                '[PingCommand] PRE-ENQUEUE: Preparing ping response for testuser'
            );
            expect(logger.info).toHaveBeenCalledWith(
                { channel: '#testchannel', user: 'testuser' },
                '[PingCommand] POST-ENQUEUE: Successfully called enqueueMessage'
            );
            expect(logger.info).toHaveBeenCalledWith(
                'Executed !ping command in #testchannel for testuser'
            );
        });

    });
});

