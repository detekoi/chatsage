// src/components/commands/handlers/timer.js
import {
    addTimer,
    updateTimerResponse,
    updateTimerOptions,
    removeTimer,
    getTimer,
    getTimersForChannel,
    findUnsupportedTimerVariables,
    TimersStorageError,
    sanitizeTimerName,
    RESERVED_TIMER_NAMES,
    MIN_INTERVAL_MINUTES,
    MAX_INTERVAL_MINUTES,
    MAX_MIN_CHAT_LINES,
    MAX_RESPONSE_LENGTH,
    DEFAULT_MIN_CHAT_LINES,
} from '../../timers/timersStorage.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { sendLocalized } from '../../../lib/localizedMessage.js';

/**
 * Handler for the !timer meta-command.
 * Allows moderators/broadcasters to manage timed messages via chat.
 *
 * Usage:
 *   !timer add <name> <minutes> <message>   → Add a timed message
 *   !timer addai <name> <minutes> <prompt>  → Add an AI-generated timed message
 *   !timer edit <name> <message>            → Edit a timer's message/prompt
 *   !timer interval <name> <minutes>        → Change how often it fires
 *   !timer lines <name> <count>             → Chat lines required between fires
 *   !timer enable <name> / disable <name>   → Toggle a timer
 *   !timer remove <name>                    → Delete a timer
 *   !timer show <name>                      → Show a timer's settings
 *   !timer list                             → List all timers
 */
async function execute(context) {
    const { channel, user, args, logger } = context;
    const channelName = channel.substring(1); // Remove '#'
    const username = user.username;

    if (args.length === 0) {
        await sendLocalized(channel, 'cmd.timer.UsageTimerAddAddai', {}, `Usage: !timer add/addai/edit/interval/lines/enable/disable/remove/show/list <name> [...]`);
        return;
    }

    const subCommand = args[0].toLowerCase();
    const timerName = args[1]?.toLowerCase();

    switch (subCommand) {
        case 'add':
            await _handleAdd(channel, channelName, timerName, args.slice(2), username, 'text', logger);
            break;
        case 'addai':
            await _handleAdd(channel, channelName, timerName, args.slice(2), username, 'prompt', logger);
            break;
        case 'edit':
            await _handleEdit(channel, channelName, timerName, args.slice(2), logger);
            break;
        case 'interval':
            await _handleInterval(channel, channelName, timerName, args[2], logger);
            break;
        case 'lines':
            await _handleLines(channel, channelName, timerName, args[2], logger);
            break;
        case 'enable':
        case 'disable':
            await _handleToggle(channel, channelName, timerName, subCommand === 'enable', logger);
            break;
        case 'remove':
        case 'delete':
            await _handleRemove(channel, channelName, timerName, logger);
            break;
        case 'show':
            await _handleShow(channel, channelName, timerName, logger);
            break;
        case 'list':
            await _handleList(channel, channelName, logger);
            break;
        default:
            await sendLocalized(channel, 'cmd.timer.UnknownSubcommandUseAdd', { subCommand }, `Unknown subcommand "${subCommand}". Use add, addai, edit, interval, lines, enable, disable, remove, show, or list.`);
    }
}

function _parseInterval(value) {
    const minutes = parseInt(value, 10);
    if (isNaN(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
        return null;
    }
    return minutes;
}

async function _handleAdd(channel, channelName, timerName, responseArgs, username, type, logger) {
    const usage = `Usage: !timer ${type === 'prompt' ? 'addai' : 'add'} <name> <minutes> <${type === 'prompt' ? 'prompt' : 'message'}>`;
    if (!timerName) {
        await sendLocalized(channel, 'cmd.timer.PleaseSpecifyTimerName', { usage }, `Please specify a timer name. ${usage}`);
        return;
    }

    const sanitizedName = sanitizeTimerName(timerName);
    if (!sanitizedName) {
        await sendLocalized(channel, 'cmd.timer.TimerNameSanitizedNothing', {}, `Timer name sanitized to nothing — try a name with letters or numbers.`);
        return;
    }
    
    // We reassign to use the sanitized version for all storage operations
    timerName = sanitizedName;

    if (RESERVED_TIMER_NAMES.includes(timerName)) {
        await sendLocalized(channel, 'cmd.timer.ReservedWordCanT', { timerName }, `"${timerName}" is a reserved word and can't be used as a timer name.`);
        return;
    }

    const intervalMinutes = _parseInterval(responseArgs[0]);
    if (intervalMinutes === null) {
        await sendLocalized(channel, 'cmd.timer.PleaseSpecifyIntervalBetween', { MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES, usage }, `Please specify an interval between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES} minutes. ${usage}`);
        return;
    }

    const response = responseArgs.slice(1).join(' ');
    if (!response) {
        await sendLocalized(channel,
            type === 'prompt' ? 'cmd.timer.PleaseSpecifyPrompt' : 'cmd.timer.PleaseSpecifyMessage',
            { usage },
            `Please specify a ${type === 'prompt' ? 'prompt' : 'message'}. ${usage}`);
        return;
    }
    if (response.length > MAX_RESPONSE_LENGTH) {
        await sendLocalized(channel, 'cmd.timer.TimerTextMustCharacters', { MAX_RESPONSE_LENGTH }, `Timer text must be ${MAX_RESPONSE_LENGTH} characters or fewer.`);
        return;
    }
    const offenders = findUnsupportedTimerVariables(response);
    if (offenders.length > 0) {
        await sendLocalized(channel, 'cmd.timer.TimersFireWithoutTriggering', { p1: offenders.join(', ') }, `Timers fire without a triggering user, so these variables aren't supported: ${offenders.join(', ')}`);
        return;
    }

    try {
        const created = await addTimer(channelName, timerName, response, username, type, intervalMinutes, DEFAULT_MIN_CHAT_LINES);
        if (created) {
            await sendLocalized(channel, 'cmd.timer.TimerAddedFiresEvery', { timerName, p2: type === 'prompt' ? ' (AI Mode)' : '', intervalMinutes }, `Timer "${timerName}" added${type === 'prompt' ? ' (AI Mode)' : ''} — fires every ${intervalMinutes}m when the stream is live and chat is active.`);
            logger.info(`[TimerHandler] ${username} added timer ${timerName} (type: ${type}, every ${intervalMinutes}m) in ${channelName}`);
        } else {
            await sendLocalized(channel, 'cmd.timer.TimerAlreadyExistsUse', { timerName }, `Timer "${timerName}" already exists. Use "!timer edit" to update it.`);
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName, timer: timerName },
            '[TimerHandler] Error adding timer');
        // A storage error carries its own message; otherwise use the catalogued generic one.
        if (error instanceof TimersStorageError && !error.cause) {
            await enqueueMessage(channel, error.message);
        } else {
            await sendLocalized(channel, 'cmd.timer.ErrorAddingTimer', {},
                'Error adding timer. Please try again later.');
        }
    }
}

async function _handleEdit(channel, channelName, timerName, responseArgs, logger) {
    if (!timerName) {
        await sendLocalized(channel, 'cmd.timer.PleaseSpecifyTimerName2', {}, `Please specify a timer name. Usage: !timer edit <name> <message>`);
        return;
    }
    const response = responseArgs.join(' ');
    if (!response) {
        await sendLocalized(channel, 'cmd.timer.PleaseSpecifyNewText', { timerName }, `Please specify the new text. Usage: !timer edit ${timerName} <message>`);
        return;
    }
    if (response.length > MAX_RESPONSE_LENGTH) {
        await sendLocalized(channel, 'cmd.timer.TimerTextMustCharacters', { MAX_RESPONSE_LENGTH }, `Timer text must be ${MAX_RESPONSE_LENGTH} characters or fewer.`);
        return;
    }

    try {
        const existing = await getTimer(channelName, timerName);
        if (!existing) {
            await sendLocalized(channel, 'cmd.timer.TimerNotFoundUse', { timerName }, `Timer "${timerName}" not found. Use "!timer add" to create it.`);
            return;
        }
        const offenders = findUnsupportedTimerVariables(response);
        if (offenders.length > 0) {
            await sendLocalized(channel, 'cmd.timer.TimersFireWithoutTriggering', { p1: offenders.join(', ') }, `Timers fire without a triggering user, so these variables aren't supported: ${offenders.join(', ')}`);
            return;
        }

        await updateTimerResponse(channelName, timerName, response);
        await sendLocalized(channel, 'cmd.timer.TimerHasBeenUpdated', { timerName }, `Timer "${timerName}" has been updated.`);
        logger.info(`[TimerHandler] Updated timer ${timerName} in ${channelName}`);
    } catch (error) {
        logger.error({ err: error, channel: channelName, timer: timerName },
            '[TimerHandler] Error editing timer');
        await sendLocalized(channel, 'cmd.timer.ErrorEditingTimerPlease', {}, `Error editing timer. Please try again later.`);
    }
}

async function _handleInterval(channel, channelName, timerName, value, logger) {
    if (!timerName) {
        await sendLocalized(channel, 'cmd.timer.UsageTimerIntervalName', {}, `Usage: !timer interval <name> <minutes>`);
        return;
    }
    const intervalMinutes = _parseInterval(value);
    if (intervalMinutes === null) {
        await sendLocalized(channel, 'cmd.timer.IntervalMustBetweenMinutes', { MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES }, `Interval must be between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES} minutes.`);
        return;
    }

    try {
        const updated = await updateTimerOptions(channelName, timerName, { intervalMinutes });
        if (updated) {
            await sendLocalized(channel, 'cmd.timer.TimerNowFiresEvery', { timerName, intervalMinutes }, `Timer "${timerName}" now fires every ${intervalMinutes}m.`);
        } else {
            await sendLocalized(channel, 'cmd.timer.TimerNotFound', { timerName }, `Timer "${timerName}" not found.`);
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName, timer: timerName },
            '[TimerHandler] Error updating interval');
        await sendLocalized(channel, 'cmd.timer.ErrorUpdatingTimerPlease', {}, `Error updating timer. Please try again later.`);
    }
}

async function _handleLines(channel, channelName, timerName, value, logger) {
    if (!timerName) {
        await sendLocalized(channel, 'cmd.timer.UsageTimerLinesName', {}, `Usage: !timer lines <name> <count>`);
        return;
    }
    const minChatLines = parseInt(value, 10);
    if (isNaN(minChatLines) || minChatLines < 0 || minChatLines > MAX_MIN_CHAT_LINES) {
        await sendLocalized(channel, 'cmd.timer.ChatLinesMustBetween', { MAX_MIN_CHAT_LINES }, `Chat lines must be between 0 and ${MAX_MIN_CHAT_LINES}.`);
        return;
    }

    try {
        const updated = await updateTimerOptions(channelName, timerName, { minChatLines });
        if (updated) {
            await sendLocalized(channel,
                minChatLines === 0 ? 'cmd.timer.LinesCleared' : 'cmd.timer.LinesSet',
                { timerName, minChatLines },
                minChatLines === 0
                    ? `Timer "${timerName}" no longer requires chat activity to fire.`
                    : `Timer "${timerName}" now requires ${minChatLines} chat lines between fires.`);
        } else {
            await sendLocalized(channel, 'cmd.timer.TimerNotFound', { timerName }, `Timer "${timerName}" not found.`);
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName, timer: timerName },
            '[TimerHandler] Error updating chat lines');
        await sendLocalized(channel, 'cmd.timer.ErrorUpdatingTimerPlease', {}, `Error updating timer. Please try again later.`);
    }
}

async function _handleToggle(channel, channelName, timerName, enabled, logger) {
    if (!timerName) {
        await sendLocalized(channel, 'cmd.timer.UsageTimerName', { p1: enabled ? 'enable' : 'disable' }, `Usage: !timer ${enabled ? 'enable' : 'disable'} <name>`);
        return;
    }

    try {
        const updated = await updateTimerOptions(channelName, timerName, { enabled });
        if (updated) {
            await sendLocalized(channel,
                enabled ? 'cmd.timer.TimerEnabled' : 'cmd.timer.TimerDisabled',
                { timerName },
                `Timer "${timerName}" has been ${enabled ? 'enabled' : 'disabled'}.`);
        } else {
            await sendLocalized(channel, 'cmd.timer.TimerNotFound', { timerName }, `Timer "${timerName}" not found.`);
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName, timer: timerName },
            '[TimerHandler] Error toggling timer');
        await sendLocalized(channel, 'cmd.timer.ErrorUpdatingTimerPlease', {}, `Error updating timer. Please try again later.`);
    }
}

async function _handleRemove(channel, channelName, timerName, logger) {
    if (!timerName) {
        await sendLocalized(channel, 'cmd.timer.PleaseSpecifyTimerName3', {}, `Please specify a timer name. Usage: !timer remove <name>`);
        return;
    }

    try {
        const removed = await removeTimer(channelName, timerName);
        if (removed) {
            await sendLocalized(channel, 'cmd.timer.TimerHasBeenRemoved', { timerName }, `Timer "${timerName}" has been removed.`);
            logger.info(`[TimerHandler] Removed timer ${timerName} from ${channelName}`);
        } else {
            await sendLocalized(channel, 'cmd.timer.TimerNotFound', { timerName }, `Timer "${timerName}" not found.`);
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName, timer: timerName },
            '[TimerHandler] Error removing timer');
        await sendLocalized(channel, 'cmd.timer.ErrorRemovingTimerPlease', {}, `Error removing timer. Please try again later.`);
    }
}

async function _handleShow(channel, channelName, timerName, logger) {
    if (!timerName) {
        await sendLocalized(channel, 'cmd.timer.PleaseSpecifyTimerName4', {}, `Please specify a timer name. Usage: !timer show <name>`);
        return;
    }

    try {
        const timer = await getTimer(channelName, timerName);
        if (timer) {
            const typeInfo = timer.type === 'prompt' ? ' [AI]' : '';
            const statusInfo = timer.enabled === false ? ' [disabled]' : '';
            await sendLocalized(channel, 'cmd.timer.TimerEveryMMin', { timerName, typeInfo, statusInfo, intervalMinutes: timer.intervalMinutes, minChatLines: timer.minChatLines, response: timer.response }, `Timer "${timerName}"${typeInfo}${statusInfo} — every ${timer.intervalMinutes}m, min ${timer.minChatLines} lines: ${timer.response}`);
        } else {
            await sendLocalized(channel, 'cmd.timer.TimerNotFound', { timerName }, `Timer "${timerName}" not found.`);
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName, timer: timerName },
            '[TimerHandler] Error showing timer');
        await sendLocalized(channel, 'cmd.timer.ErrorFetchingTimerPlease', {}, `Error fetching timer. Please try again later.`);
    }
}

async function _handleList(channel, channelName, logger) {
    try {
        const timers = await getTimersForChannel(channelName);
        if (timers.length === 0) {
            await sendLocalized(channel, 'cmd.timer.NoTimersConfiguredUse', {}, `No timers configured. Use "!timer add <name> <minutes> <message>" to create one.`);
            return;
        }
        const summary = timers
            .map(t => `${t.name}${t.type === 'prompt' ? ' [AI]' : ''} (${t.intervalMinutes}m${t.enabled === false ? ', off' : ''})`)
            .join(', ');
        await sendLocalized(channel, 'cmd.timer.Timers', { length: timers.length, summary }, `Timers (${timers.length}): ${summary}`);
    } catch (error) {
        logger.error({ err: error, channel: channelName },
            '[TimerHandler] Error listing timers');
        await sendLocalized(channel, 'cmd.timer.ErrorListingTimersPlease', {}, `Error listing timers. Please try again later.`);
    }
}

export default {
    execute,
    permission: 'moderator', // Only moderators and broadcasters can manage timers
    description: 'Manage timed messages (add/addai/edit/interval/lines/enable/disable/remove/show/list)',
};
