// tests/unit/customCommands/command.test.js
import commandHandler from '../../../src/components/commands/handlers/command.js';

const { execute } = commandHandler;

// Mock storage layer
jest.mock('../../../src/components/customCommands/customCommandsStorage.js', () => ({
    addCustomCommand: jest.fn(),
    updateCustomCommand: jest.fn(),
    removeCustomCommand: jest.fn(),
    getCustomCommand: jest.fn(),
    updateCustomCommandOptions: jest.fn(),
}));

// Mock logger
jest.mock('../../../src/lib/logger.js', () => ({
    __esModule: true,
    default: {
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
        error: jest.fn(),
    },
}));

import {
    addCustomCommand,
    updateCustomCommand,
    removeCustomCommand,
    getCustomCommand,
    updateCustomCommandOptions,
} from '../../../src/components/customCommands/customCommandsStorage.js';

import logger from '../../../src/lib/logger.js';

describe('command handler (!command)', () => {
    let mockIrcClient;

    const makeContext = (argsString) => ({
        channel: '#testchannel',
        user: { username: 'moduser', 'display-name': 'ModUser' },
        args: argsString ? argsString.split(' ') : [],
        ircClient: mockIrcClient,
        logger: logger,
    });

    beforeEach(() => {
        jest.clearAllMocks();
        mockIrcClient = {
            say: jest.fn().mockResolvedValue(),
        };
    });

    // =========================================================================
    // No arguments
    // =========================================================================
    test('shows usage when called with no args', async () => {
        await execute(makeContext(''));
        expect(mockIrcClient.say).toHaveBeenCalledWith(
            '#testchannel',
            expect.stringContaining('Usage'),
        );
    });

    // =========================================================================
    // Unknown subcommand
    // =========================================================================
    test('shows error for unknown subcommand', async () => {
        await execute(makeContext('foo'));
        expect(mockIrcClient.say).toHaveBeenCalledWith(
            '#testchannel',
            expect.stringContaining('Unknown subcommand'),
        );
    });

    // =========================================================================
    // !command add
    // =========================================================================
    describe('add', () => {
        test('adds a command successfully', async () => {
            addCustomCommand.mockResolvedValue(true);
            await execute(makeContext('add greet Hello $(user)!'));
            expect(addCustomCommand).toHaveBeenCalledWith('testchannel', 'greet', 'Hello $(user)!', 'moduser');
            expect(mockIrcClient.say).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('has been added'),
            );
        });

        test('reports when command already exists', async () => {
            addCustomCommand.mockResolvedValue(false);
            await execute(makeContext('add greet Hello!'));
            expect(mockIrcClient.say).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('already exists'),
            );
        });

        test('shows usage when no command name given', async () => {
            await execute(makeContext('add'));
            expect(mockIrcClient.say).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('specify a command name'),
            );
        });

        test('shows usage when no response given', async () => {
            await execute(makeContext('add greet'));
            expect(mockIrcClient.say).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('specify a response'),
            );
        });

        test('strips ! from command name', async () => {
            addCustomCommand.mockResolvedValue(true);
            await execute(makeContext('add !greet Hello!'));
            expect(addCustomCommand).toHaveBeenCalledWith('testchannel', 'greet', 'Hello!', 'moduser');
        });

        test('handles storage error gracefully', async () => {
            addCustomCommand.mockRejectedValue(new Error('Firestore error'));
            await execute(makeContext('add greet Hello!'));
            expect(mockIrcClient.say).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('Error adding command'),
            );
        });
    });

    // =========================================================================
    // !command edit
    // =========================================================================
    describe('edit', () => {
        test('edits a command successfully', async () => {
            updateCustomCommand.mockResolvedValue(true);
            await execute(makeContext('edit greet New response!'));
            expect(updateCustomCommand).toHaveBeenCalledWith('testchannel', 'greet', 'New response!');
            expect(mockIrcClient.say).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('updated'),
            );
        });

        test('reports when command not found', async () => {
            updateCustomCommand.mockResolvedValue(false);
            await execute(makeContext('edit greet New response!'));
            expect(mockIrcClient.say).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('not found'),
            );
        });
    });

    // =========================================================================
    // !command remove
    // =========================================================================
    describe('remove', () => {
        test('removes a command successfully', async () => {
            removeCustomCommand.mockResolvedValue(true);
            await execute(makeContext('remove greet'));
            expect(removeCustomCommand).toHaveBeenCalledWith('testchannel', 'greet');
            expect(mockIrcClient.say).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('has been removed'),
            );
        });

        test('reports when command not found', async () => {
            removeCustomCommand.mockResolvedValue(false);
            await execute(makeContext('remove greet'));
            expect(mockIrcClient.say).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('not found'),
            );
        });

        test('"delete" alias works', async () => {
            removeCustomCommand.mockResolvedValue(true);
            await execute(makeContext('delete greet'));
            expect(removeCustomCommand).toHaveBeenCalledWith('testchannel', 'greet');
        });

        test('shows usage when no command name given', async () => {
            await execute(makeContext('remove'));
            expect(mockIrcClient.say).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('specify a command name'),
            );
        });
    });

    // =========================================================================
    // !command show
    // =========================================================================
    describe('show', () => {
        test('shows command response template', async () => {
            getCustomCommand.mockResolvedValue({
                response: 'Hello $(user)!',
                permission: 'everyone',
                cooldownMs: 0,
            });
            await execute(makeContext('show greet'));
            expect(mockIrcClient.say).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('Hello $(user)!'),
            );
        });

        test('shows permission and cooldown info when set', async () => {
            getCustomCommand.mockResolvedValue({
                response: 'VIP only',
                permission: 'vip',
                cooldownMs: 30000,
            });
            await execute(makeContext('show viponly'));
            const msg = mockIrcClient.say.mock.calls[0][1];
            expect(msg).toContain('[vip]');
            expect(msg).toContain('30s cooldown');
        });

        test('reports when command not found', async () => {
            getCustomCommand.mockResolvedValue(null);
            await execute(makeContext('show nonexistent'));
            expect(mockIrcClient.say).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('not found'),
            );
        });
    });

    // =========================================================================
    // !command options
    // =========================================================================
    describe('options', () => {
        test('sets permission successfully', async () => {
            updateCustomCommandOptions.mockResolvedValue(true);
            await execute(makeContext('options greet permission=moderator'));
            expect(updateCustomCommandOptions).toHaveBeenCalledWith(
                'testchannel', 'greet', { permission: 'moderator' },
            );
            expect(mockIrcClient.say).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('updated'),
            );
        });

        test('sets cooldown successfully', async () => {
            updateCustomCommandOptions.mockResolvedValue(true);
            await execute(makeContext('options greet cooldown=30'));
            expect(updateCustomCommandOptions).toHaveBeenCalledWith(
                'testchannel', 'greet', { cooldownMs: 30000 },
            );
        });

        test('accepts cd alias for cooldown', async () => {
            updateCustomCommandOptions.mockResolvedValue(true);
            await execute(makeContext('options greet cd=10'));
            expect(updateCustomCommandOptions).toHaveBeenCalledWith(
                'testchannel', 'greet', { cooldownMs: 10000 },
            );
        });

        test('rejects invalid permission value', async () => {
            await execute(makeContext('options greet permission=admin'));
            expect(mockIrcClient.say).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('Invalid permission'),
            );
            expect(updateCustomCommandOptions).not.toHaveBeenCalled();
        });

        test('rejects negative cooldown', async () => {
            await execute(makeContext('options greet cooldown=-5'));
            expect(mockIrcClient.say).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('non-negative'),
            );
        });

        test('rejects unknown option key', async () => {
            await execute(makeContext('options greet volume=100'));
            expect(mockIrcClient.say).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('Unknown option'),
            );
        });

        test('shows usage when no options given', async () => {
            await execute(makeContext('options greet'));
            expect(mockIrcClient.say).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('Usage'),
            );
        });

        test('reports when command not found', async () => {
            updateCustomCommandOptions.mockResolvedValue(false);
            await execute(makeContext('options nonexistent permission=moderator'));
            expect(mockIrcClient.say).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('not found'),
            );
        });
    });
});
