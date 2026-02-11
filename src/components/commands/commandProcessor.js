import logger from '../../lib/logger.js';
// Import command handlers (assuming handlers/index.js exports an object/Map)
import commandHandlers from './handlers/index.js';
// We might need access to the IRC client to send command responses
import { getIrcClient } from '../twitch/ircClient.js';
// We might need context for some commands
import { getContextManager } from '../context/contextManager.js';
// Import command state manager for checking if commands are disabled
import { isCommandDisabled } from '../context/commandStateManager.js';
// Custom commands support
import { getCustomCommand, incrementUseCount } from '../customCommands/customCommandsStorage.js';
import { parseVariables } from '../customCommands/variableParser.js';
import { getChannelFollower, getUsersByLogin } from '../twitch/helixClient.js';
import { getBroadcasterAccessToken } from '../twitch/broadcasterTokenHelper.js';
import { formatFollowAge } from '../customCommands/variableParser.js';
import config from '../../config/index.js';


const COMMAND_PREFIX = '!'; // Define the prefix for commands
// Simple duplicate suppression to avoid double responses when a message is processed twice rapidly
const recentCommandInvocations = new Map(); // key -> timestamp ms
const DUPLICATE_WINDOW_MS = 20000; // 20 seconds to reliably prevent double-fires

// Cooldown tracking for custom commands
const customCommandCooldowns = new Map(); // "channel:command" -> last used timestamp

function _makeDedupKey(channelName, username, command, args, messageId = null) {
    // Prefer messageId if available (tmi.js may provide tags.id)
    if (messageId) {
        return `${channelName}#${messageId}`;
    }
    // Fallback: compose from user+command+args
    return `${channelName}:${username}:${command}:${args.join(' ')}`;
}

function _shouldSuppressDuplicate(key) {
    const now = Date.now();
    const last = recentCommandInvocations.get(key);
    if (last && (now - last) < DUPLICATE_WINDOW_MS) {
        return true;
    }
    recentCommandInvocations.set(key, now);
    // Opportunistic cleanup of stale entries
    if (recentCommandInvocations.size > 500) {
        for (const [k, ts] of recentCommandInvocations) {
            if ((now - ts) > DUPLICATE_WINDOW_MS) {
                recentCommandInvocations.delete(k);
            }
        }
    }
    return false;
}

/**
 * Checks if a custom command is on cooldown.
 * @param {string} channelName - Channel name.
 * @param {string} commandName - Command name.
 * @param {number} cooldownMs - Cooldown in milliseconds.
 * @returns {boolean} True if on cooldown.
 */
function _isCustomCommandOnCooldown(channelName, commandName, cooldownMs) {
    if (cooldownMs <= 0) return false;
    const key = `${channelName}:${commandName}`;
    const lastUsed = customCommandCooldowns.get(key);
    if (lastUsed && (Date.now() - lastUsed) < cooldownMs) {
        return true;
    }
    customCommandCooldowns.set(key, Date.now());
    return false;
}

/**
 * Checks if a user has the required custom command permission.
 * @param {string} permission - Required permission level.
 * @param {object} tags - tmi.js message tags.
 * @param {string} channelName - Channel name.
 * @returns {boolean} True if user has permission.
 */
function _hasCustomCommandPermission(permission, tags, channelName) {
    if (!permission || permission === 'everyone') return true;

    const isBroadcaster = tags.badges?.broadcaster === '1' || tags.username === channelName;
    const isModerator = tags.mod === '1' || tags.badges?.moderator === '1';
    const isVip = tags.badges?.vip === '1';
    const isSubscriber = tags.subscriber === '1' || tags.badges?.subscriber === '1';

    switch (permission) {
        case 'broadcaster': return isBroadcaster;
        case 'moderator': return isModerator || isBroadcaster;
        case 'vip': return isVip || isModerator || isBroadcaster;
        case 'subscriber': return isSubscriber || isVip || isModerator || isBroadcaster;
        default: return true;
    }
}

/**
 * Creates a getFollowage function bound to the current request context.
 * This is passed to the variable parser for resolving $(followage).
 */
function _createFollowageResolver(channelName) {
    return async (targetDisplayName, channel) => {
        try {
            const broadcasterToken = await getBroadcasterAccessToken(channel || channelName);
            if (!broadcasterToken) return 'followage unavailable (auth required)';

            const contextManager = getContextManager();
            const broadcasterId = await contextManager.getBroadcasterId(channel || channelName);
            if (!broadcasterId) return 'followage unavailable';

            // Look up the user ID from their display name
            const users = await getUsersByLogin([targetDisplayName.toLowerCase()]);
            if (!users || users.length === 0) return 'user not found';

            const followData = await getChannelFollower(
                broadcasterId,
                users[0].id,
                broadcasterToken.accessToken,
                config.twitch.clientId,
            );

            if (followData) {
                return formatFollowAge(followData.followed_at);
            }
            return 'not following';
        } catch (error) {
            logger.warn({ error: error.message }, '[CommandProcessor] Error resolving followage variable');
            return 'followage unavailable';
        }
    };
}


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
        // No built-in handler found — check for custom commands
        logger.debug(`No built-in handler for: ${command}. Checking custom commands...`);
        return await _tryCustomCommand(channelName, tags, command, args);
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
        // Duplicate suppression check (use tmi message id if present)
        const messageId = tags['id'] || tags['message-id'] || null;
        const dedupKey = _makeDedupKey(channelName, tags.username, command, args, messageId);
        if (_shouldSuppressDuplicate(dedupKey)) {
            logger.warn({ channel: channelName, user: tags.username, command, args }, 'Suppressing duplicate command invocation detected within window.');
            return true;
        }

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

/**
 * Tries to execute a custom command for the given channel.
 * @param {string} channelName - Channel name (without '#').
 * @param {object} tags - tmi.js message tags.
 * @param {string} command - Command name (without !).
 * @param {string[]} args - Command arguments.
 * @returns {Promise<boolean>} True if a custom command was found and executed.
 */
async function _tryCustomCommand(channelName, tags, command, args) {
    try {
        const customCmd = await getCustomCommand(channelName, command);
        if (!customCmd) {
            return false; // No custom command found either
        }

        logger.debug({ command, channel: channelName }, 'Found custom command');

        // Permission check
        if (!_hasCustomCommandPermission(customCmd.permission, tags, channelName)) {
            logger.debug(`User ${tags.username} lacks permission for custom command !${command}`);
            return false;
        }

        // Cooldown check
        if (_isCustomCommandOnCooldown(channelName, command, customCmd.cooldownMs || 0)) {
            logger.debug(`Custom command !${command} is on cooldown in ${channelName}`);
            return true; // Consumed the command, just not responding
        }

        // Increment use count (non-blocking)
        const useCountPromise = incrementUseCount(channelName, command);

        // Get stream context for variable resolution
        const contextManager = getContextManager();
        const streamContext = contextManager.getStreamContextSnapshot(channelName);

        // Resolve the use count before parsing variables
        const useCount = await useCountPromise;

        // Parse variables in the response
        const displayName = tags['display-name'] || tags.username;
        const resolvedResponse = await parseVariables(customCmd.response, {
            user: displayName,
            channel: channelName,
            args,
            useCount,
            streamContext,
            getFollowage: _createFollowageResolver(channelName),
        });

        // Send the response
        const ircClient = getIrcClient();
        await ircClient.say(`#${channelName}`, resolvedResponse);

        logger.info(`Executed custom command !${command} for ${tags.username} in #${channelName}`);
        return true;
    } catch (error) {
        logger.error({ err: error, command, channel: channelName },
            '[CommandProcessor] Error executing custom command');
        return false;
    }
}

// Export the necessary functions
export { initializeCommandProcessor, processMessage };