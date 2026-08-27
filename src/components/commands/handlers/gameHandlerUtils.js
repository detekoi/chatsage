// src/components/commands/handlers/gameHandlerUtils.js
import logger from '../../../lib/logger.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { isPrivilegedUser } from '../../../lib/permissions.js';
import { sendLocalized, sendLocalizedResult } from '../../../lib/localizedMessage.js';
import { getContextManager } from '../../context/contextManager.js';
import { isCatalogued } from '../../../lib/i18n.js';

/**
 * Wraps enqueueMessage with secondary error handling.
 * Use inside catch blocks or anywhere a rejection should not propagate.
 * @param {string} channel - Channel to send to (with #).
 * @param {string} text - Message text.
 * @param {object} opts - Options ({ replyToId, ... }).
 * @param {string} logTag - Tag for warning logs (e.g., '[GeoGame]').
 */
export async function safeReply(channel, text, opts, logTag) {
    try {
        await enqueueMessage(channel, text, opts);
    } catch (msgError) {
        logger.warn({ err: msgError }, `${logTag} Failed to send message to chat`);
    }
}

/**
 * safeReply for a fixed, catalog-backed string.
 * @param {string} channel - Channel to send to (with #).
 * @param {string} key - Dotted catalog key.
 * @param {object} params - Interpolation values.
 * @param {string} fallback - English text.
 * @param {object} opts - Options ({ replyToId, ... }).
 * @param {string} logTag - Tag for warning logs.
 */
export async function safeReplyLocalized(channel, key, params, fallback, opts, logTag) {
    try {
        await sendLocalized(channel, key, params, fallback, opts);
    } catch (msgError) {
        logger.warn({ err: msgError }, `${logTag} Failed to send message to chat`);
    }
}

/**
 * The channel's configured bot language, or null. Formatters take this so their fixed wrapper text
 * comes from the catalog instead of being machine-translated on the way out.
 * @param {string} channelName - Channel name without '#'.
 * @returns {string|null}
 */
export function channelLanguage(channelName) {
    try {
        return getContextManager()?.getBotLanguage?.(channelName) || null;
    } catch {
        return null;
    }
}

/**
 * Extracts common context from the handler context object.
 * @param {object} context - The command handler context.
 * @returns {object} Common game context fields.
 */
export function extractGameContext(context) {
    const { channel, user, args } = context;
    const channelName = channel.substring(1);
    const username = user.username.toLowerCase();
    const displayName = user['display-name'] || user.username;
    const replyToId = user?.id || user?.['message-id'] || null;
    const isMod = isPrivilegedUser(user, channelName);

    return { channel, channelName, username, displayName, replyToId, isMod, args };
}

/**
 * Handles the 'stop' subcommand for any game.
 * Checks if a game is active, verifies permissions, and calls manager.stopGame().
 * @param {object} gameCtx - from extractGameContext.
 * @param {object} manager - game manager instance.
 * @param {string} gameName - display name for messages ('Geo-Game', 'Trivia', 'Riddle').
 */
export async function handleStop(gameCtx, manager, gameName) {
    const { channel, channelName, username, displayName, replyToId, isMod } = gameCtx;
    const currentInitiator = manager.getCurrentGameInitiator(channelName);

    if (!currentInitiator) {
        await sendLocalized(channel, 'cmd.gameHandlerUtils.ThereNoActiveStop', { gameName }, `There is no active ${gameName} to stop.`, { replyToId });
        return;
    }

    if (isMod || username === currentInitiator) {
        const result = manager.stopGame(channelName);
        logger.info(`[${gameName}] Stop requested by ${displayName}, result: ${result?.message || 'handled by manager'}`);
    } else {
        await sendLocalized(channel, 'cmd.gameHandlerUtils.OnlyGameInitiatorMods', {}, `Only the game initiator, mods, or the broadcaster can stop the current game.`, { replyToId });
    }
}

/**
 * Handles 'leaderboard' subcommand.
 * @param {object} gameCtx - from extractGameContext.
 * @param {Function} getLeaderboardFn - storage getLeaderboard(channelName, limit).
 * @param {Function} formatFn - formatter(leaderboardData, channelName) → string.
 * @param {string} gameName - for log/error messages.
 */
export async function handleLeaderboard(gameCtx, getLeaderboardFn, formatFn, gameName) {
    const { channel, channelName, replyToId } = gameCtx;

    try {
        const leaderboardData = await getLeaderboardFn(channelName, 5);
        const lang = channelLanguage(channelName);
        const message = formatFn(leaderboardData, channelName, lang);
        await enqueueMessage(channel, message,
            isCatalogued(lang) ? { replyToId, skipTranslation: true } : { replyToId });
        logger.info(`[${gameName}] Displayed leaderboard for channel ${channelName}`);
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `Error fetching or formatting ${gameName} leaderboard.`);
        await safeReplyLocalized(channel, 'cmd.game.LeaderboardFetchFailed', {}, `Sorry, couldn't fetch the leaderboard right now.`, { replyToId }, `[${gameName}]`);
    }
}

/**
 * Handles 'clearleaderboard'/'resetstats'/'cleardata' subcommand.
 * Requires mod/broadcaster permissions.
 * @param {object} gameCtx - from extractGameContext.
 * @param {object} manager - must have .clearLeaderboard(channelName).
 * @param {string} gameName - for messages.
 */
export async function handleClearLeaderboard(gameCtx, manager, gameName) {
    const { channel, channelName, replyToId, isMod } = gameCtx;

    if (!isMod) {
        await sendLocalized(channel, 'cmd.gameHandlerUtils.OnlyModsOrBroadcaster', {}, `Only mods or the broadcaster can clear the leaderboard.`, { replyToId });
        return;
    }

    await sendLocalized(channel, 'cmd.gameHandlerUtils.AttemptingClearLeaderboardData', { gameName }, `Attempting to clear ${gameName} leaderboard data for this channel. This may take a moment...`, { replyToId });

    try {
        const result = await manager.clearLeaderboard(channelName);
        await sendLocalizedResult(channel, result, { replyToId });
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `Error calling clearLeaderboard from ${gameName} handler.`);
        await safeReplyLocalized(channel, 'cmd.game.ClearLeaderboardFailed', {}, `An unexpected error occurred while trying to clear the leaderboard.`, { replyToId }, `[${gameName}]`);
    }
}

/**
 * Handles 'resetconfig' subcommand.
 * Requires mod/broadcaster permissions.
 * @param {object} gameCtx - from extractGameContext.
 * @param {object} manager - must have .resetChannelConfig(channelName).
 * @param {string} gameName - for messages.
 */
export async function handleResetConfig(gameCtx, manager, gameName) {
    const { channel, channelName, replyToId, isMod } = gameCtx;

    if (!isMod) {
        await sendLocalized(channel, 'cmd.gameHandlerUtils.OnlyModsOrBroadcaster2', {}, `Only mods or the broadcaster can reset the game configuration.`, { replyToId });
        return;
    }

    try {
        const result = await manager.resetChannelConfig(channelName);
        await sendLocalizedResult(channel, result, { replyToId });
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `Error calling resetChannelConfig from ${gameName} handler.`);
        await safeReplyLocalized(channel, 'cmd.game.ResetConfigFailed', {}, `An unexpected error occurred while trying to reset the configuration.`, { replyToId }, `[${gameName}]`);
    }
}

/**
 * Handles 'report'/'flag' subcommand.
 * @param {object} gameCtx - from extractGameContext.
 * @param {object} manager - must have .initiateReportProcess(channelName, reason, username).
 * @param {string} gameName - display name for log/error messages.
 * @param {string} commandName - the actual command name for usage hints (e.g., 'geo', 'trivia').
 */
export async function handleReport(gameCtx, manager, gameName, commandName) {
    const { channel, channelName, username, displayName, replyToId, args } = gameCtx;

    if (args.length < 2) {
        await sendLocalized(channel, 'cmd.gameHandlerUtils.PleaseProvideReasonReporting', { commandName }, `Please provide a reason for reporting. Usage: !${commandName} report <your reason>`, { replyToId });
        return;
    }

    const reason = args.slice(1).join(' ');
    logger.info(`[${gameName}] ${displayName} is initiating report for last session in ${channelName}. Reason: ${reason}`);

    try {
        const result = await manager.initiateReportProcess(channelName, reason, username);
        if (result.message) {
            await sendLocalizedResult(channel, result, { replyToId });
        } else if (!result.success) {
            await sendLocalized(channel, 'cmd.gameHandlerUtils.CouldNotProcessReport', {}, `Could not process your report request at this time.`, { replyToId });
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: username }, `Error calling initiateReportProcess for ${gameName}.`);
        await safeReplyLocalized(channel, 'cmd.game.ReportFailed', {}, `An error occurred while trying to initiate the report.`, { replyToId }, `[${gameName}]`);
    }
}

/**
 * Handles 'config' subcommand with a game-specific schema.
 * Parses key-value pairs from args according to the schema definition.
 *
 * Schema entry format:
 *   { keys: string[], type: 'int'|'bool'|'list'|'enum', optionName: string, enumValues?: string[] }
 *
 * @param {object} gameCtx - from extractGameContext.
 * @param {object} manager - must have .configureGame(channelName, options).
 * @param {Array} schema - config option definitions.
 * @param {string} usageMessage - usage hint to show when no valid options provided.
 * @param {string} gameName - for log messages.
 */
export async function handleConfig(gameCtx, manager, schema, usageMessage, gameName) {
    const { channel, channelName, replyToId, isMod, args } = gameCtx;

    if (!isMod) {
        await sendLocalized(channel, 'cmd.gameHandlerUtils.OnlyModsOrBroadcaster3', {}, `Only mods or the broadcaster can configure the game.`, { replyToId });
        return;
    }

    const options = {};

    for (let i = 1; i < args.length; i += 2) {
        const key = args[i]?.toLowerCase();
        const value = args[i + 1];
        if (!key || !value) continue;

        const entry = schema.find(s => s.keys.includes(key));
        if (!entry) continue;

        switch (entry.type) {
            case 'int': {
                const parsed = parseInt(value, 10);
                if (!isNaN(parsed)) options[entry.optionName] = parsed;
                break;
            }
            case 'bool':
                options[entry.optionName] = value.toLowerCase() === 'true' || value === '1';
                break;
            case 'list':
                options[entry.optionName] = value.split(',').map(s => s.trim()).filter(Boolean);
                break;
            case 'enum':
                if (entry.enumValues?.includes(value.toLowerCase())) {
                    options[entry.optionName] = value.toLowerCase();
                }
                break;
        }
    }

    if (Object.keys(options).length === 0) {
        await enqueueMessage(channel, usageMessage, { replyToId });
        return;
    }

    const result = await manager.configureGame(channelName, options);
    await sendLocalizedResult(channel, result, { replyToId });
    logger.info(`[${gameName}] Configuration updated for channel ${channelName}: ${JSON.stringify(options)}`);
}

/**
 * Validates round count and clamps to maxRounds, sending a message if clamped.
 * @param {object} gameCtx - from extractGameContext.
 * @param {number} rounds - requested round count.
 * @param {number} [maxRounds=10] - maximum allowed rounds.
 * @returns {Promise<number>} clamped round count.
 */
export async function validateRounds(gameCtx, rounds, maxRounds = 10) {
    if (rounds > maxRounds) {
        const { channel, replyToId } = gameCtx;
        await sendLocalized(channel, 'cmd.gameHandlerUtils.MaximumNumberRoundsStarting', { maxRounds }, `Maximum number of rounds is ${maxRounds}. Starting a ${maxRounds}-round game.`, { replyToId });
        return maxRounds;
    }
    return rounds;
}

/**
 * Starts a game via the provided async start function and handles the
 * common error/failure response pattern.
 * @param {object} gameCtx - from extractGameContext.
 * @param {Function} startFn - async () => { success, error }.
 * @param {string} gameName - for log/error messages.
 */
export async function startGameWithErrorHandling(gameCtx, startFn, gameName) {
    const { channel, replyToId } = gameCtx;

    try {
        const result = await startFn();
        if (!result.success) {
            await sendLocalizedResult(channel, { message: result.error, messageKey: result.errorKey, messageParams: result.errorParams }, { replyToId });
        }
    } catch (error) {
        logger.error({ err: error }, `Unhandled error starting ${gameName} game from command handler.`);
        await safeReplyLocalized(channel, 'cmd.game.StartGameFailed', {}, `An unexpected error occurred trying to start the game.`, { replyToId }, `[${gameName}]`);
    }
}

/**
 * Helper to check if a string is a positive integer (1, 2, 3, ...).
 * @param {string} str - string to check.
 * @returns {boolean}
 */
export function isPositiveInteger(str) {
    return /^[1-9]\d*$/.test(str);
}
