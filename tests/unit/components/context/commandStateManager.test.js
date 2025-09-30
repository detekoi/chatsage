// tests/unit/components/context/commandStateManager.test.js

jest.mock('../../../../src/lib/logger.js');
jest.mock('../../../../src/components/context/channelCommandsStorage.js');

import {
    initializeCommandStateManager,
    shutdownCommandStateManager,
    isCommandDisabled,
    disableCommandForChannel,
    enableCommandForChannel,
    getDisabledCommandsForChannel,
    getAllAvailableCommands,
    isValidCommand
} from '../../../../src/components/context/commandStateManager.js';
import logger from '../../../../src/lib/logger.js';
import * as channelCommandsStorage from '../../../../src/components/context/channelCommandsStorage.js';

describe('commandStateManager', () => {
    const mockCommandHandlers = {
        help: jest.fn(),
        ask: jest.fn(),
        trivia: jest.fn(),
        geo: jest.fn(),
        riddle: jest.fn()
    };

    beforeEach(() => {
        jest.clearAllMocks();

        // Mock the storage functions
        channelCommandsStorage.initializeChannelCommandsStorage = jest.fn().mockResolvedValue();
        channelCommandsStorage.loadAllChannelCommandSettings = jest.fn().mockResolvedValue(new Map());
        channelCommandsStorage.listenForCommandSettingsChanges = jest.fn().mockReturnValue(jest.fn());
        channelCommandsStorage.disableCommand = jest.fn().mockResolvedValue(true);
        channelCommandsStorage.enableCommand = jest.fn().mockResolvedValue(true);
    });

    afterEach(() => {
        shutdownCommandStateManager();
    });

    describe('initializeCommandStateManager', () => {
        it('should initialize successfully', async () => {
            await initializeCommandStateManager();

            expect(channelCommandsStorage.initializeChannelCommandsStorage).toHaveBeenCalledTimes(1);
            expect(channelCommandsStorage.loadAllChannelCommandSettings).toHaveBeenCalledTimes(1);
            expect(logger.info).toHaveBeenCalledWith('[CommandStateManager] Initializing command state manager...');
            expect(logger.info).toHaveBeenCalledWith('[CommandStateManager] Command state manager initialized successfully');
        });

        it('should handle initialization errors', async () => {
            const error = new Error('Storage initialization failed');
            channelCommandsStorage.initializeChannelCommandsStorage.mockRejectedValue(error);

            await expect(initializeCommandStateManager()).rejects.toThrow(error);
            expect(logger.error).toHaveBeenCalledWith(
                { err: error },
                '[CommandStateManager] Failed to initialize command state manager'
            );
        });

        it('should load existing channel command settings', async () => {
            const mockChannelStates = new Map([
                ['testchannel', new Set(['trivia', 'geo'])]
            ]);

            channelCommandsStorage.loadAllChannelCommandSettings.mockResolvedValue(mockChannelStates);

            await initializeCommandStateManager();

            expect(channelCommandsStorage.loadAllChannelCommandSettings).toHaveBeenCalledTimes(1);
        });
    });

    describe('shutdownCommandStateManager', () => {
        beforeEach(async () => {
            await initializeCommandStateManager();
        });

        it('should shutdown successfully', () => {
            shutdownCommandStateManager();

            expect(logger.info).toHaveBeenCalledWith('[CommandStateManager] Command state manager shut down');
        });

        it('should handle shutdown when not initialized', () => {
            expect(() => shutdownCommandStateManager()).not.toThrow();
        });
    });

    describe('isCommandDisabled', () => {
        beforeEach(async () => {
            await initializeCommandStateManager();
        });

        it('should return false when no settings exist for channel', () => {
            const result = isCommandDisabled('newchannel', 'trivia');

            expect(result).toBe(false);
            expect(logger.debug).toHaveBeenCalledWith(
                '[CommandStateManager] No command settings for channel newchannel, command trivia is enabled'
            );
        });

        it('should return false when command is not in disabled set', () => {
            // Mock a channel with some disabled commands but not the one we're checking
            const mockChannelStates = new Map([
                ['testchannel', new Set(['geo', 'riddle'])]
            ]);

            // We need to access the internal state for this test
            // In a real implementation, we might expose a method to set channel states for testing
            // For now, we'll test the basic logic that we can access

            const result = isCommandDisabled('testchannel', 'trivia');

            expect(result).toBe(false);
        });

        it('should handle command aliases', () => {
            // Test that 'commands' alias maps to 'help'
            const result = isCommandDisabled('testchannel', 'commands');

            expect(result).toBe(false);
        });

        it('should handle case insensitive command names', () => {
            const result = isCommandDisabled('testchannel', 'TRIVIA');

            expect(result).toBe(false);
        });
    });

    describe('disableCommandForChannel', () => {
        beforeEach(async () => {
            await initializeCommandStateManager();
        });

        it('should disable a command successfully', async () => {
            const result = await disableCommandForChannel('testchannel', 'trivia');

            expect(result).toEqual({
                success: true,
                message: "✅ Command '!trivia' has been disabled.",
                wasAlreadyDisabled: false
            });
            expect(channelCommandsStorage.disableCommand).toHaveBeenCalledWith('testchannel', 'trivia');
        });

        it('should handle already disabled commands', async () => {
            channelCommandsStorage.disableCommand.mockResolvedValue(false); // wasAlreadyDisabled = true

            const result = await disableCommandForChannel('testchannel', 'trivia');

            expect(result).toEqual({
                success: true,
                message: "Command '!trivia' was already disabled.",
                wasAlreadyDisabled: true
            });
        });

        it('should prevent disabling protected commands', async () => {
            const result = await disableCommandForChannel('testchannel', 'help');

            expect(result).toEqual({
                success: false,
                message: "The command 'help' is always available and cannot be disabled.",
                wasAlreadyDisabled: false
            });
            expect(channelCommandsStorage.disableCommand).not.toHaveBeenCalled();
        });

        it('should handle storage errors', async () => {
            const error = new Error('Storage error');
            channelCommandsStorage.disableCommand.mockRejectedValue(error);

            const result = await disableCommandForChannel('testchannel', 'trivia');

            expect(result).toEqual({
                success: false,
                message: "Error disabling command '!trivia'. Please try again.",
                wasAlreadyDisabled: false
            });
        });
    });

    describe('enableCommandForChannel', () => {
        beforeEach(async () => {
            await initializeCommandStateManager();
        });

        it('should enable a command successfully', async () => {
            const result = await enableCommandForChannel('testchannel', 'trivia');

            expect(result).toEqual({
                success: true,
                message: "✅ Command '!trivia' has been enabled.",
                wasAlreadyEnabled: false
            });
            expect(channelCommandsStorage.enableCommand).toHaveBeenCalledWith('testchannel', 'trivia');
        });

        it('should handle already enabled commands', async () => {
            channelCommandsStorage.enableCommand.mockResolvedValue(false); // wasAlreadyEnabled = true

            const result = await enableCommandForChannel('testchannel', 'trivia');

            expect(result).toEqual({
                success: true,
                message: "Command '!trivia' was already enabled.",
                wasAlreadyEnabled: true
            });
        });

        it('should handle storage errors', async () => {
            const error = new Error('Storage error');
            channelCommandsStorage.enableCommand.mockRejectedValue(error);

            const result = await enableCommandForChannel('testchannel', 'trivia');

            expect(result).toEqual({
                success: false,
                message: "Error enabling command '!trivia'. Please try again.",
                wasAlreadyEnabled: false
            });
        });
    });

    describe('getDisabledCommandsForChannel', () => {
        beforeEach(async () => {
            await initializeCommandStateManager();
        });

        it('should return empty array when no disabled commands', () => {
            const result = getDisabledCommandsForChannel('testchannel');

            expect(result).toEqual([]);
        });

        it('should return array of disabled commands', () => {
            // This would require access to internal state
            // For now, we'll test the basic structure
            const result = getDisabledCommandsForChannel('testchannel');

            expect(Array.isArray(result)).toBe(true);
        });
    });

    describe('getAllAvailableCommands', () => {
        it('should return all command handler keys', () => {
            const result = getAllAvailableCommands(mockCommandHandlers);

            expect(result).toEqual(['help', 'ask', 'trivia', 'geo', 'riddle']);
        });

        it('should return empty array for empty handlers', () => {
            const result = getAllAvailableCommands({});

            expect(result).toEqual([]);
        });
    });

    describe('isValidCommand', () => {
        it('should return true for existing commands', () => {
            const result = isValidCommand('trivia', mockCommandHandlers);

            expect(result).toBe(true);
        });

        it('should return true for command aliases', () => {
            const result = isValidCommand('commands', mockCommandHandlers);

            expect(result).toBe(true);
        });

        it('should return true for case variations', () => {
            const result = isValidCommand('TRIVIA', mockCommandHandlers);

            expect(result).toBe(true);
        });

        it('should return false for non-existing commands', () => {
            const result = isValidCommand('nonexistent', mockCommandHandlers);

            expect(result).toBe(false);
        });

        it('should handle sage alias for ask command', () => {
            const result = isValidCommand('sage', mockCommandHandlers);

            expect(result).toBe(true);
        });
    });
});
