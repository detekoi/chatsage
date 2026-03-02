// src/components/commands/handlers/command.js
import {
    addCustomCommand,
    updateCustomCommand,
    removeCustomCommand,
    getCustomCommand,
    updateCustomCommandOptions,
} from '../../customCommands/customCommandsStorage.js';
import { enqueueMessage } from '../../../lib/ircSender.js';

/**
 * Handler for the !command meta-command.
 * Allows moderators/broadcasters to manage custom commands via chat.
 *
 * Usage:
 *   !command add <name> <response>       → Add a new custom command
 *   !command addai <name> <prompt>       → Add a new LLM-powered custom command
 *   !command edit <name> <response>      → Edit an existing command's response
 *   !command remove <name>               → Remove a custom command
 *   !command show <name>                 → Show the raw response template
 *   !command options <name> <key>=<val>  → Change command options (permission, cooldown, type)
 */
async function execute(context) {
    const { channel, user, args, logger } = context;
    const channelName = channel.substring(1); // Remove '#'
    const username = user.username;

    if (args.length === 0) {
        await enqueueMessage(channel,
            `Usage: !command add/addai/edit/remove/show/options <name> [response/options]`);
        return;
    }

    const subCommand = args[0].toLowerCase();
    const commandName = args[1]?.toLowerCase()?.replace(/^!/, '');

    switch (subCommand) {
        case 'add':
            await _handleAdd(channel, channelName, commandName, args.slice(2), username, 'text', logger);
            break;
        case 'addai':
            await _handleAdd(channel, channelName, commandName, args.slice(2), username, 'prompt', logger);
            break;
        case 'edit':
            await _handleEdit(channel, channelName, commandName, args.slice(2), logger);
            break;
        case 'remove':
        case 'delete':
            await _handleRemove(channel, channelName, commandName, logger);
            break;
        case 'show':
            await _handleShow(channel, channelName, commandName, logger);
            break;
        case 'options':
            await _handleOptions(channel, channelName, commandName, args.slice(2), logger);
            break;
        default:
            await enqueueMessage(channel,
                `Unknown subcommand "${subCommand}". Use add, addai, edit, remove, show, or options.`);
    }
}

async function _handleAdd(channel, channelName, commandName, responseArgs, username, type, logger) {
    if (!commandName) {
        await enqueueMessage(channel, `Please specify a command name. Usage: !command ${type === 'prompt' ? 'addai' : 'add'} <name> <response>`);
        return;
    }
    if (responseArgs.length === 0) {
        await enqueueMessage(channel, `Please specify a response. Usage: !command ${type === 'prompt' ? 'addai' : 'add'} ${commandName} <response>`);
        return;
    }

    const response = responseArgs.join(' ');

    try {
        const created = await addCustomCommand(channelName, commandName, response, username, type);
        if (created) {
            await enqueueMessage(channel, `Command !${commandName} has been added ${type === 'prompt' ? '(AI Mode)' : ''}.`);
            logger.info(`[CommandHandler] ${username} added !${commandName} (type: ${type}) in ${channelName}`);
        } else {
            await enqueueMessage(channel, `Command !${commandName} already exists. Use "!command edit" to update it.`);
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName, command: commandName },
            '[CommandHandler] Error adding command');
        await enqueueMessage(channel, `Error adding command. Please try again later.`);
    }
}

async function _handleEdit(channel, channelName, commandName, responseArgs, logger) {
    if (!commandName) {
        await enqueueMessage(channel, `Please specify a command name. Usage: !command edit <name> <response>`);
        return;
    }
    if (responseArgs.length === 0) {
        await enqueueMessage(channel, `Please specify a new response. Usage: !command edit ${commandName} <response>`);
        return;
    }

    const response = responseArgs.join(' ');

    try {
        const updated = await updateCustomCommand(channelName, commandName, response);
        if (updated) {
            await enqueueMessage(channel, `Command !${commandName} has been updated.`);
            logger.info(`[CommandHandler] Updated !${commandName} in ${channelName}`);
        } else {
            await enqueueMessage(channel, `Command !${commandName} not found. Use "!command add" to create it.`);
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName, command: commandName },
            '[CommandHandler] Error editing command');
        await enqueueMessage(channel, `Error editing command. Please try again later.`);
    }
}

async function _handleRemove(channel, channelName, commandName, logger) {
    if (!commandName) {
        await enqueueMessage(channel, `Please specify a command name. Usage: !command remove <name>`);
        return;
    }

    try {
        const removed = await removeCustomCommand(channelName, commandName);
        if (removed) {
            await enqueueMessage(channel, `Command !${commandName} has been removed.`);
            logger.info(`[CommandHandler] Removed !${commandName} from ${channelName}`);
        } else {
            await enqueueMessage(channel, `Command !${commandName} not found.`);
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName, command: commandName },
            '[CommandHandler] Error removing command');
        await enqueueMessage(channel, `Error removing command. Please try again later.`);
    }
}

async function _handleShow(channel, channelName, commandName, logger) {
    if (!commandName) {
        await enqueueMessage(channel, `Please specify a command name. Usage: !command show <name>`);
        return;
    }

    try {
        const cmd = await getCustomCommand(channelName, commandName);
        if (cmd) {
            const permInfo = cmd.permission !== 'everyone' ? ` [${cmd.permission}]` : '';
            const cooldownInfo = cmd.cooldownMs > 0 ? ` [${cmd.cooldownMs / 1000}s cd]` : '';
            const typeInfo = cmd.type === 'prompt' ? ` [AI]` : '';
            await enqueueMessage(channel,
                `!${commandName}${permInfo}${cooldownInfo}${typeInfo}: ${cmd.response}`);
        } else {
            await enqueueMessage(channel, `Command !${commandName} not found.`);
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName, command: commandName },
            '[CommandHandler] Error showing command');
        await enqueueMessage(channel, `Error fetching command. Please try again later.`);
    }
}

async function _handleOptions(channel, channelName, commandName, optionArgs, logger) {
    if (!commandName) {
        await enqueueMessage(channel, `Usage: !command options <name> <key>=<value>`);
        return;
    }
    if (optionArgs.length === 0) {
        await enqueueMessage(channel,
            `Usage: !command options ${commandName} permission=moderator or cooldown=30`);
        return;
    }

    const options = {};
    const validPermissions = ['everyone', 'subscriber', 'vip', 'moderator', 'broadcaster'];

    for (const arg of optionArgs) {
        const [key, value] = arg.split('=');
        if (!key || !value) continue;

        switch (key.toLowerCase()) {
            case 'permission':
            case 'perm':
                if (validPermissions.includes(value.toLowerCase())) {
                    options.permission = value.toLowerCase();
                } else {
                    await enqueueMessage(channel,
                        `Invalid permission. Valid options: ${validPermissions.join(', ')}`);
                    return;
                }
                break;
            case 'cooldown':
            case 'cd': {
                const seconds = parseInt(value, 10);
                if (isNaN(seconds) || seconds < 0) {
                    await enqueueMessage(channel, `Cooldown must be a non-negative number (in seconds).`);
                    return;
                }
                options.cooldownMs = seconds * 1000;
                break;
            }
            case 'type':
                if (value.toLowerCase() === 'prompt' || value.toLowerCase() === 'text') {
                    options.type = value.toLowerCase();
                } else {
                    await enqueueMessage(channel, `Invalid type. Valid options: text, prompt`);
                    return;
                }
                break;
            default:
                await enqueueMessage(channel, `Unknown option "${key}". Available: permission, cooldown, type`);
                return;
        }
    }

    if (Object.keys(options).length === 0) {
        await enqueueMessage(channel, `No valid options provided.`);
        return;
    }

    try {
        const updated = await updateCustomCommandOptions(channelName, commandName, options);
        if (updated) {
            const changes = Object.entries(options)
                .map(([k, v]) => `${k}=${k === 'cooldownMs' ? `${v / 1000}s` : v}`)
                .join(', ');
            await enqueueMessage(channel, `Options for !${commandName} updated: ${changes}`);
            logger.info(`[CommandHandler] Updated options for !${commandName} in ${channelName}: ${changes}`);
        } else {
            await enqueueMessage(channel, `Command !${commandName} not found.`);
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName, command: commandName },
            '[CommandHandler] Error updating options');
        await enqueueMessage(channel, `Error updating options. Please try again later.`);
    }
}

export default {
    execute,
    permission: 'moderator', // Only moderators and broadcasters can manage commands
    description: 'Manage custom commands (add/edit/remove/show/options)',
};
