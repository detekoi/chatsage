// src/components/context/commandStateManager.js
import logger from '../../lib/logger.js';
import {
    initializeChannelCommandsStorage,
    loadAllChannelCommandSettings,
    listenForCommandSettingsChanges,
    disableCommand,
    enableCommand
} from './channelCommandsStorage.js';

// In-memory cache of command states per channel
// Map<channelName, Set<disabledCommandNames>>
let channelCommandStates = new Map();
let firestoreListener = null;

/**
 * Command alias mappings - maps alias to primary command name
 * This ensures that disabling a command affects all its aliases
 */
// Every alias registered in commands/handlers/index.js, so disabling a
// command also disables its alias.
const COMMAND_ALIASES = {
    'commands': 'help',
    'sage': 'ask',
    'quotes': 'quote',
    'timers': 'timer'
};

/**
 * Commands that cannot be disabled: !enable and !disable so a channel cannot
 * lock its moderators out of re-enabling commands, and !forgetme so a viewer
 * can always opt out of channel memory. The dashboard writes disabledCommands
 * directly, so isCommandDisabled() ignores these even when the stored list
 * names them. chatsage-web-ui keeps the same list (ALWAYS_ON_COMMANDS in
 * functions/src/config/constants.ts); change both together.
 */
const PROTECTED_COMMANDS = new Set(['enable', 'disable', 'forgetme']);

/**
 * Initializes the command state manager.
 * Loads all channel command settings and sets up real-time listeners.
 */
export async function initializeCommandStateManager() {
    logger.info("[CommandStateManager] Initializing command state manager...");

    try {
        // Initialize the storage layer
        await initializeChannelCommandsStorage();

        // Load all existing channel command settings
        channelCommandStates = await loadAllChannelCommandSettings();
        logger.info(`[CommandStateManager] Loaded command states for ${channelCommandStates.size} channels`);

        // Drop any listener from a previous initialization before registering a new one; two
        // live snapshot handlers would both write to channelCommandStates.
        if (typeof firestoreListener === 'function') {
            firestoreListener();
            firestoreListener = null;
        }

        // Set up real-time listener for changes
        firestoreListener = listenForCommandSettingsChanges((channelName, disabledCommandsSet) => {
            logger.debug(`[CommandStateManager] Updating cached command state for channel ${channelName}`);
            channelCommandStates.set(channelName, disabledCommandsSet);
        });

        logger.info("[CommandStateManager] Command state manager initialized successfully");
    } catch (error) {
        logger.error({ err: error }, "[CommandStateManager] Failed to initialize command state manager");
        throw error;
    }
}

/**
 * Shuts down the command state manager, cleaning up listeners.
 */
export function shutdownCommandStateManager() {
    if (firestoreListener) {
        logger.info("[CommandStateManager] Cleaning up Firestore listener...");
        firestoreListener();
        firestoreListener = null;
    }
    channelCommandStates.clear();
    logger.info("[CommandStateManager] Command state manager shut down");
}

/**
 * Normalizes a command name to its primary name, handling aliases.
 * @param {string} commandName - The command name to normalize.
 * @returns {string} The primary command name.
 */
function normalizeCommandName(commandName) {
    return COMMAND_ALIASES[commandName.toLowerCase()] || commandName.toLowerCase();
}

/**
 * Checks whether a command, or its alias, can never be disabled.
 * @param {string} commandName - The command name.
 * @returns {boolean} True for a protected command.
 */
export function isProtectedCommand(commandName) {
    return PROTECTED_COMMANDS.has(normalizeCommandName(commandName));
}

/**
 * Checks if a command is disabled for a specific channel.
 * @param {string} channelName - The channel name (without #).
 * @param {string} commandName - The command name to check.
 * @returns {boolean} True if the command is disabled, false otherwise.
 */
export function isCommandDisabled(channelName, commandName) {
    const normalizedChannel = channelName.toLowerCase();
    const normalizedCommand = normalizeCommandName(commandName);

    if (isProtectedCommand(normalizedCommand)) {
        return false;
    }

    const disabledCommands = channelCommandStates.get(normalizedChannel);
    if (!disabledCommands) {
        // No settings for this channel means all commands are enabled
        logger.debug(`[CommandStateManager] No command settings for channel ${normalizedChannel}, command ${normalizedCommand} is enabled`);
        return false;
    }

    const isDisabled = disabledCommands.has(normalizedCommand);
    logger.debug(`[CommandStateManager] Command ${normalizedCommand} in channel ${normalizedChannel} is ${isDisabled ? 'disabled' : 'enabled'}`);
    return isDisabled;
}

/**
 * Disables a command for a specific channel.
 * @param {string} channelName - The channel name (without #).
 * @param {string} commandName - The command name to disable.
 * @returns {Promise<{success: boolean, message: string, wasAlreadyDisabled: boolean}>}
 */
export async function disableCommandForChannel(channelName, commandName) {
    const normalizedChannel = channelName.toLowerCase();
    const normalizedCommand = normalizeCommandName(commandName);

    // Check if it's a protected command
    if (isProtectedCommand(normalizedCommand)) {
        return {
            success: false,
            messageKey: 'result.commandState.CommandAlwaysAvailableCannot', messageParams: { normalizedCommand }, message: `The command '${normalizedCommand}' is always available and cannot be disabled.`,
            wasAlreadyDisabled: false
        };
    }

    try {
        const wasNewlyDisabled = await disableCommand(normalizedChannel, normalizedCommand);

        // Update local cache immediately
        if (!channelCommandStates.has(normalizedChannel)) {
            channelCommandStates.set(normalizedChannel, new Set());
        }
        channelCommandStates.get(normalizedChannel).add(normalizedCommand);

        return {
            success: true,
            messageKey: wasNewlyDisabled
                ? 'result.commandState.CommandDisabled'
                : 'result.commandState.CommandAlreadyDisabled',
            messageParams: { commandName },
            message: wasNewlyDisabled
                ? `✅ Command '!${commandName}' has been disabled.`
                : `Command '!${commandName}' was already disabled.`,
            wasAlreadyDisabled: !wasNewlyDisabled
        };
    } catch (error) {
        logger.error({ err: error, channel: normalizedChannel, command: normalizedCommand },
            `[CommandStateManager] Error disabling command ${normalizedCommand} for channel ${normalizedChannel}`);
        return {
            success: false,
            messageKey: 'result.commandState.ErrorDisablingCommandPlease', messageParams: { commandName }, message: `Error disabling command '!${commandName}'. Please try again.`,
            wasAlreadyDisabled: false
        };
    }
}

/**
 * Enables a command for a specific channel.
 * @param {string} channelName - The channel name (without #).
 * @param {string} commandName - The command name to enable.
 * @returns {Promise<{success: boolean, message: string, wasAlreadyEnabled: boolean}>}
 */
export async function enableCommandForChannel(channelName, commandName) {
    const normalizedChannel = channelName.toLowerCase();
    const normalizedCommand = normalizeCommandName(commandName);

    try {
        // A protected command was running even if the stored list named it,
        // so removing that stale entry still reports it as already enabled.
        const wasNewlyEnabled = await enableCommand(normalizedChannel, normalizedCommand)
            && !isProtectedCommand(normalizedCommand);

        // Update local cache immediately
        const disabledCommands = channelCommandStates.get(normalizedChannel);
        if (disabledCommands) {
            disabledCommands.delete(normalizedCommand);
        }

        return {
            success: true,
            messageKey: wasNewlyEnabled
                ? 'result.commandState.CommandEnabled'
                : 'result.commandState.CommandAlreadyEnabled',
            messageParams: { commandName },
            message: wasNewlyEnabled
                ? `✅ Command '!${commandName}' has been enabled.`
                : `Command '!${commandName}' was already enabled.`,
            wasAlreadyEnabled: !wasNewlyEnabled
        };
    } catch (error) {
        logger.error({ err: error, channel: normalizedChannel, command: normalizedCommand },
            `[CommandStateManager] Error enabling command ${normalizedCommand} for channel ${normalizedChannel}`);
        return {
            success: false,
            messageKey: 'result.commandState.ErrorEnablingCommandPlease', messageParams: { commandName }, message: `Error enabling command '!${commandName}'. Please try again.`,
            wasAlreadyEnabled: false
        };
    }
}

/**
 * Gets the list of disabled commands for a channel.
 * @param {string} channelName - The channel name (without #).
 * @returns {string[]} Array of disabled command names.
 */
export function getDisabledCommandsForChannel(channelName) {
    const normalizedChannel = channelName.toLowerCase();
    const disabledCommands = channelCommandStates.get(normalizedChannel);
    // A protected command in the stored list is not disabled (isCommandDisabled).
    return disabledCommands ? Array.from(disabledCommands).filter(cmd => !isProtectedCommand(cmd)) : [];
}

/**
 * Gets all available command names from the command handlers.
 * This is used by the enable/disable commands to validate command names.
 * @param {Object} commandHandlers - The command handlers object from the command processor.
 * @returns {string[]} Array of all available command names.
 */
export function getAllAvailableCommands(commandHandlers) {
    return Object.keys(commandHandlers);
}

/**
 * Validates if a command name exists in the available commands.
 * @param {string} commandName - The command name to validate.
 * @param {Object} commandHandlers - The command handlers object.
 * @returns {boolean} True if the command exists, false otherwise.
 */
export function isValidCommand(commandName, commandHandlers) {
    const normalizedCommand = normalizeCommandName(commandName);
    return Object.prototype.hasOwnProperty.call(commandHandlers, normalizedCommand) ||
        Object.keys(commandHandlers).includes(commandName.toLowerCase());
}