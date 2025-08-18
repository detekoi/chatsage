import logger from '../../lib/logger.js';
// Import command handlers (assuming handlers/index.js exports an object/Map)
import commandHandlers from './handlers/index.js';
// We might need access to the IRC client to send command responses
import { getIrcClient } from '../twitch/ircClient.js';
// We might need context for some commands
import { getContextManager } from '../context/contextManager.js';
// Import command state manager for checking if commands are disabled
import { isCommandDisabled } from '../context/commandStateManager.js';


const COMMAND_PREFIX = '!'; // Define the prefix for commands

/**
 * Initializes the Command Processor.
 * Currently just logs, but could pre-load/validate handlers in the future.
 */
function initializeCommandProcessor() {
    logger.info('Initializing Command Processor...');
    // Log registered commands
    const registeredCommands = Object.keys(commandHandlers);
    if (registeredCommands.length > 0) {
         logger.info(`Registered commands: ${registeredCommands.join(', ')}`);
    } else {
        logger.warn('No command handlers found or loaded.');
    }
}

/**
 * Parses a message to extract command name and arguments.
 * @param {string} message - The raw message content.
 * @returns {{command: string, args: string[]} | null} Parsed command and args, or null if not a command.
 */
function parseCommand(message) {
    if (!message.startsWith(COMMAND_PREFIX)) {
        return null;
    }

    const args = message.slice(COMMAND_PREFIX.length).trim().split(/ +/g);
    const command = args.shift()?.toLowerCase(); // Get command name (lowercase)

    if (!command) {
        return null; // Just the prefix was typed
    }

    return { command, args };
}

/**
 * Checks if the user has the required permission level for a command.
 * @param {object} handler - The command handler object.
 * @param {object} tags - The user's message tags from tmi.js.
 * @param {string} channelName - The channel the command was issued in.
 * @returns {boolean} True if the user has permission, false otherwise.
 */
function hasPermission(handler, tags, channelName) {
    const requiredPermission = handler.permission || 'everyone'; // Default to everyone

    if (requiredPermission === 'everyone') {
        return true;
    }

    const isBroadcaster = tags.badges?.broadcaster === '1' || tags.username === channelName;
    if (requiredPermission === 'broadcaster' && isBroadcaster) {
        return true;
    }

    const isModerator = tags.mod === '1' || tags.badges?.moderator === '1';
    if (requiredPermission === 'moderator' && (isModerator || isBroadcaster)) {
        // Moderators or the broadcaster can use mod commands
        return true;
    }

    // Add other roles like VIP, subscriber later if needed
    // const isVip = tags.badges?.vip === '1';
    // const isSubscriber = tags.subscriber === '1' || tags.badges?.subscriber === '1';

    return false;
}

/**
 * Processes an incoming chat message to check for and execute commands.
 * @param {string} channelName - Channel name (without '#').
 * @param {object} tags - tmi.js message tags.
 * @param {string} message - Raw message content.
 * @returns {Promise<boolean>} True if a command was successfully found and executed (or attempted), false otherwise.
 */
async function processMessage(channelName, tags, message) {
    // Add debugging for incoming message
    logger.debug({ channelName, user: tags.username, message }, 'processMessage called');
    
    const parsed = parseCommand(message);

    if (!parsed) {
        logger.debug('Message not a command or just prefix');
        return false; // Not a command or just the prefix
    }

    const { command, args } = parsed;
    logger.debug({ command, args }, 'Parsed command');
    
    const handler = commandHandlers[command];
    logger.debug({ command, handlerExists: !!handler }, 'Command handler lookup result');

    if (!handler || typeof handler.execute !== 'function') {
        logger.debug(`Command prefix used, but no handler found for: ${command}`);
        return false;
    }

    // --- Command Disabled Check ---
    logger.debug(`Checking if command !${command} is disabled in #${channelName}`);
    const commandDisabled = isCommandDisabled(channelName, command);
    logger.debug({ commandDisabled }, 'Command disabled check result');
    
    if (commandDisabled) {
        logger.debug(`Command !${command} is disabled in #${channelName}, ignoring silently`);
        return false; // Silently ignore disabled commands
    }

    // --- Permission Check ---
    logger.debug(`Checking permission for command !${command}`);
    const permitted = hasPermission(handler, tags, channelName);
    logger.debug({ permitted }, 'Permission check result');
    
    if (!permitted) {
        logger.debug(`User ${tags.username} lacks permission for command !${command} in #${channelName}`);
        // Optional: Send a whisper or message indicating lack of permission? Be careful about spam.
        return false;
    }

    // --- Execute Command ---
    logger.info(`Executing command !${command} for user ${tags.username} in #${channelName}`);
    try {
        const context = {
            channel: `#${channelName}`, // Pass channel name with '#' for tmi.js functions
            user: tags,
            args: args,
            message: message,
            ircClient: getIrcClient(),       // Provide access to send messages
            contextManager: getContextManager(), // Provide access to state if needed
            logger: logger                   // Provide logger instance
        };
        // Execute the command's handler function
        await handler.execute(context);
        return true; // Command was successfully executed

    } catch (error) {
        logger.error({ err: error, command: command, user: tags.username, channel: channelName },
            `Error executing command !${command}`);
        // Optional: Send an error message back to the chat?
        try {
            const ircClient = getIrcClient();
            await ircClient.say(`#${channelName}`, `Oops! Something went wrong trying to run !${command}.`);
        } catch (sayError) {
             logger.error({ err: sayError }, 'Failed to send command execution error message to chat.');
        }
        return true; // Command was attempted, even though it failed
    }
}

// Export the necessary functions
export { initializeCommandProcessor, processMessage };