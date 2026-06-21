// src/components/commands/handlers/geo.js
import logger from '../../../lib/logger.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { getGeoGameManager } from '../../geo/geoGameManager.js';
import { getContextManager } from '../../context/contextManager.js';
import { getLeaderboard } from '../../geo/geoStorage.js';
import {
    extractGameContext,
    handleStop,
    handleLeaderboard,
    handleClearLeaderboard,
    handleResetConfig,
    handleReport,
    handleConfig,
    validateRounds,
    startGameWithErrorHandling,
    safeReply,
    isPositiveInteger,
} from './gameHandlerUtils.js';

const GAME_NAME = 'Geo-Game';
const COMMAND_NAME = 'geo';

/**
 * Helper function to format the leaderboard message.
 * @param {Array<{id: string, data: object}>} leaderboardData - Data from getLeaderboard.
 * @param {string} channelName - The channel name for context.
 * @returns {string} Formatted leaderboard message.
 */
function formatLeaderboardMessage(leaderboardData, channelName) {
    if (!leaderboardData || leaderboardData.length === 0) {
        return `No Geo-Game stats found for this channel (${channelName}) yet!`;
    }

    // Sort by channel points (getLeaderboard should already do this, but double-check)
    leaderboardData.sort((a, b) => (b.data?.channelPoints || 0) - (a.data?.channelPoints || 0));

    const topPlayers = leaderboardData.slice(0, 5); // Show top 5

    const listItems = topPlayers.map((player, index) => {
        const rank = index + 1;
        const name = player.data?.displayName || player.id;
        const points = player.data?.channelPoints || 0;
        const wins = player.data?.channelSuccesses || 0;
        return `${rank}. ${name} (${points} pts, ${wins} wins)`;
    });

    return `🏆 Geo-Game Top Players in #${channelName}: ${listItems.join(', ')}`;
}

/**
 * Config schema for geo game options.
 */
const GEO_CONFIG_SCHEMA = [
    { keys: ['difficulty'], type: 'enum', optionName: 'difficulty', enumValues: ['easy', 'normal', 'hard'] },
    { keys: ['interval', 'clueinterval', 'clueintervalseconds'], type: 'int', optionName: 'clueIntervalSeconds' },
    { keys: ['duration', 'roundduration', 'rounddurationminutes'], type: 'int', optionName: 'roundDurationMinutes' },
    { keys: ['region', 'regions'], type: 'list', optionName: 'regionRestrictions' },
    { keys: ['game', 'gametitle'], type: 'list', optionName: 'gameTitlePreferences' },
    { keys: ['scoring', 'scoretracking'], type: 'bool', optionName: 'scoreTracking' },
    { keys: ['points', 'basepoints'], type: 'int', optionName: 'pointsBase' },
    { keys: ['timebonus'], type: 'bool', optionName: 'pointsTimeBonus' },
    { keys: ['difficultymultiplier'], type: 'bool', optionName: 'pointsDifficultyMultiplier' },
];

const GEO_CONFIG_USAGE = `Usage: !geo config difficulty <easy|normal|hard> interval <secs> duration <mins> region <list> game <list> scoring <bool> points <num> timebonus <bool> difficultymultiplier <bool>`;

/**
 * Handler for the !geo command and its subcommands.
 */
const geoHandler = {
    name: 'geo',
    description: 'Starts or manages the Geo-Game (!geo help for details).',
    usage: '!geo [<rounds>] | stop | config <options...> | resetconfig | leaderboard | clearleaderboard | report <reason...> | help',
    permission: 'everyone', // Subcommand permissions handled inside
    execute: async (context) => {
        const gameCtx = extractGameContext(context);
        const { channel, channelName, username, displayName, replyToId, args } = gameCtx;
        const geoManager = getGeoGameManager();

        let subCommand = args[0]?.toLowerCase();
        let gameMode;
        let scope;
        let numberOfRounds = 1; // Default rounds
        let consumedArgsCount;

        // --- Subcommand Parsing ---
        if (!subCommand) {
            // !geo -> Start Real World Game (1 round, global scope)
            gameMode = 'real';
            scope = null;
            numberOfRounds = 1;
            consumedArgsCount = 0;
        } else if (isPositiveInteger(subCommand)) {
            // !geo <rounds> -> Start Real World Game (<rounds>, global scope)
            gameMode = 'real';
            scope = null;
            numberOfRounds = parseInt(subCommand, 10);
            consumedArgsCount = 1;
        } else if (subCommand === 'game') {
            // !geo game [Optional Title] [Optional Rounds]
            gameMode = 'game';
            let potentialScopeParts = [];
            let potentialRoundsArg = null;
            let remainingArgs = args.slice(1); // Args after 'game'

            if (remainingArgs.length > 0) {
                let roundsIndex = -1;
                for (let i = remainingArgs.length - 1; i >= 0; i--) {
                    if (isPositiveInteger(remainingArgs[i])) {
                        roundsIndex = i;
                        break;
                    }
                }

                if (roundsIndex !== -1) {
                    potentialRoundsArg = remainingArgs[roundsIndex];
                    potentialScopeParts = remainingArgs.slice(0, roundsIndex);
                    consumedArgsCount = 1 + roundsIndex + 1; // "game" + title parts + rounds
                } else {
                    potentialScopeParts = remainingArgs;
                    consumedArgsCount = args.length;
                }
            } else {
                consumedArgsCount = args.length;
            }

            if (potentialScopeParts.length > 0) {
                scope = potentialScopeParts.join(' '); // Specific game title provided
            } else {
                // No title parts, get title from stream context
                try {
                     const contextManager = getContextManager();
                     const llmContext = contextManager.getContextForLLM(channelName, displayName, "");
                     scope = llmContext?.streamGame || null;
                     if (!scope || scope === "N/A") {
                         await enqueueMessage(channel, `Could not detect the current game. Please specify one: !geo game <Game Title> [rounds]`, { replyToId });
                         return;
                     }
                     logger.info(`[GeoGame] Using current stream game for !geo game: ${scope}`);
                } catch (err) {
                     logger.error({ err }, "Error getting stream context for !geo game");
                     await safeReply(channel, `Error getting current stream game.`, { replyToId }, '[GeoGame]');
                     return;
                }
            }
            // Set rounds if provided
            if (potentialRoundsArg) {
                numberOfRounds = parseInt(potentialRoundsArg, 10);
            }
             // Proceed to start game below

        } else if (subCommand === 'stop') {
            await handleStop(gameCtx, geoManager, GAME_NAME);
            return;

        } else if (subCommand === 'config') {
            await handleConfig(gameCtx, geoManager, GEO_CONFIG_SCHEMA, GEO_CONFIG_USAGE, GAME_NAME);
            return;

        } else if (subCommand === 'resetconfig') {
            await handleResetConfig(gameCtx, geoManager, GAME_NAME);
            return;

        } else if (subCommand === 'leaderboard') {
            await handleLeaderboard(gameCtx, getLeaderboard, formatLeaderboardMessage, GAME_NAME);
            return;

        } else if (subCommand === 'clearleaderboard' || subCommand === 'resetstats') {
            await handleClearLeaderboard(gameCtx, geoManager, GAME_NAME);
            return;

        } else if (subCommand === 'report' || subCommand === 'flag') {
            await handleReport(gameCtx, geoManager, GAME_NAME, COMMAND_NAME);
            return;

        } else if (subCommand === 'help') {
            await enqueueMessage(channel, `Geo-Game: !geo [region] [rounds] (start real), !geo game [Title] [rounds] (start game), !geo stop (mods/initiator), !geo config <opts...> (mods), !geo resetconfig (mods), !geo leaderboard, !geo clearleaderboard (mods), !geo report <reason...>, !geo help`, { replyToId });
            return;

        } else {
            // Assume !geo <region text...> [Optional Rounds] -> Real World Game
            gameMode = 'real';
            let potentialScopeParts;
            let potentialRoundsArg = null;

            let roundsIndex = -1;
            for (let i = args.length - 1; i >= 0; i--) {
                if (isPositiveInteger(args[i])) {
                    roundsIndex = i;
                    break;
                }
            }

            if (roundsIndex !== -1) {
                potentialRoundsArg = args[roundsIndex];
                potentialScopeParts = args.slice(0, roundsIndex);
                consumedArgsCount = roundsIndex + 1;
            } else {
                potentialScopeParts = args.slice(0);
                consumedArgsCount = args.length;
            }

            if (potentialScopeParts.length > 0) {
                 scope = potentialScopeParts.join(' '); // User-defined region scope
                 logger.info(`[GeoGame] Interpreting '!geo ${args.join(' ')}' as starting real mode (Region: '${scope}') for ${numberOfRounds} round(s).`);
            } else {
                 // Should not happen if args.length > 0 and first arg wasn't a number or known subcommand
                 // but handle defensively.
                 logger.warn(`[GeoGame] Parser reached real-world scope interpretation unexpectedly for args: ${args.join(' ')}`);
                 scope = null; // Fallback to global scope
            }

            if (potentialRoundsArg) {
                numberOfRounds = parseInt(potentialRoundsArg, 10);
            }
            // Proceed to start game below
        }


        // --- Start Game Section (Common for 'real' and 'game' modes determined above) ---

        // If consumedArgsCount is less than args.length, it means some arguments were not processed
        if (consumedArgsCount < args.length) {
            logger.warn(`[GeoGame][${channelName}] Unknown arguments after primary command processing: ${args.slice(consumedArgsCount).join(' ')}`);
            await enqueueMessage(channel, `Unknown command format or extra arguments provided. Use !geo help.`, { replyToId });
            return;
        }

        // Validate number of rounds
        numberOfRounds = await validateRounds(gameCtx, numberOfRounds, 10);

        // Start the game
        logger.info(`Attempting to start Geo-Game. Mode: ${gameMode}, Scope: ${scope || 'N/A'}, Rounds: ${numberOfRounds}, Initiator: ${username}`);
        await startGameWithErrorHandling(gameCtx,
            () => geoManager.startGame(channelName, gameMode, scope, username, numberOfRounds),
            GAME_NAME
        );
    }
};

export default geoHandler;