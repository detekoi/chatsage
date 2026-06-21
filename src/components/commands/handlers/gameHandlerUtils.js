// src/components/commands/handlers/gameHandlerUtils.js
import logger from '../../../lib/logger.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { isPrivilegedUser } from '../../../lib/permissions.js';

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
        await enqueueMessage(channel, `There is no active ${gameName} to stop.`, { replyToId });
        return;
    }

    if (isMod || username === currentInitiator) {
        const result = manager.stopGame(channelName);
        logger.info(`[${gameName}] Stop requested by ${displayName}, result: ${result?.message || 'handled by manager'}`);
    } else {
        await enqueueMessage(channel, `Only the game initiator, mods, or the broadcaster can stop the current game.`, { replyToId });
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
        const message = formatFn(leaderboardData, channelName);
        await enqueueMessage(channel, message, { replyToId });
        logger.info(`[${gameName}] Displayed leaderboard for channel ${channelName}`);
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `Error fetching or formatting ${gameName} leaderboard.`);
        await safeReply(channel, `Sorry, couldn't fetch the leaderboard right now.`, { replyToId }, `[${gameName}]`);
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
        await enqueueMessage(channel, `Only mods or the broadcaster can clear the leaderboard.`, { replyToId });
        return;
    }

    await enqueueMessage(channel, `Attempting to clear ${gameName} leaderboard data for this channel. This may take a moment...`, { replyToId });

    try {
        const result = await manager.clearLeaderboard(channelName);
        await enqueueMessage(channel, `${result.message}`, { replyToId });
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `Error calling clearLeaderboard from ${gameName} handler.`);
        await safeReply(channel, `An unexpected error occurred while trying to clear the leaderboard.`, { replyToId }, `[${gameName}]`);
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
        await enqueueMessage(channel, `Only mods or the broadcaster can reset the game configuration.`, { replyToId });
        return;
    }

    try {
        const result = await manager.resetChannelConfig(channelName);
        await enqueueMessage(channel, `${result.message}`, { replyToId });
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `Error calling resetChannelConfig from ${gameName} handler.`);
        await safeReply(channel, `An unexpected error occurred while trying to reset the configuration.`, { replyToId }, `[${gameName}]`);
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
        await enqueueMessage(channel, `Please provide a reason for reporting. Usage: !${commandName} report <your reason>`, { replyToId });
        return;
    }

    const reason = args.slice(1).join(' ');
    logger.info(`[${gameName}] ${displayName} is initiating report for last session in ${channelName}. Reason: ${reason}`);

    try {
        const result = await manager.initiateReportProcess(channelName, reason, username);
        if (result.message) {
            await enqueueMessage(channel, `${result.message}`, { replyToId });
        } else if (!result.success) {
            await enqueueMessage(channel, `Could not process your report request at this time.`, { replyToId });
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: username }, `Error calling initiateReportProcess for ${gameName}.`);
        await safeReply(channel, `An error occurred while trying to initiate the report.`, { replyToId }, `[${gameName}]`);
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
        await enqueueMessage(channel, `Only mods or the broadcaster can configure the game.`, { replyToId });
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
    await enqueueMessage(channel, `${result.message}`, { replyToId });
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
        await enqueueMessage(channel, `Maximum number of rounds is ${maxRounds}. Starting a ${maxRounds}-round game.`, { replyToId });
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
            await enqueueMessage(channel, `${result.error}`, { replyToId });
        }
    } catch (error) {
        logger.error({ err: error }, `Unhandled error starting ${gameName} game from command handler.`);
        await safeReply(channel, `An unexpected error occurred trying to start the game.`, { replyToId }, `[${gameName}]`);
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
