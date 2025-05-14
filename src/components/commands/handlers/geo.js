import logger from '../../../lib/logger.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { getGeoGameManager } from '../../geo/geoGameManager.js';
// Need context manager to get current game for !geo game
import { getContextManager } from '../../context/contextManager.js';
// Need geoStorage to fetch the leaderboard
import { getLeaderboard } from '../../geo/geoStorage.js';

// Helper function to check mod/broadcaster status
function isPrivilegedUser(tags, channelName) {
    const isMod = tags.mod === '1' || tags.badges?.moderator === '1';
    const isBroadcaster = tags.badges?.broadcaster === '1' || tags.username === channelName;
    return isMod || isBroadcaster;
}

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
        // Use points field
        const points = player.data?.channelPoints || 0;
        // Optionally show wins too?
        const wins = player.data?.channelWins || 0;
        return `${rank}. ${name} (${points} pts, ${wins} wins)`; // Display points
    });

    return `🏆 Geo-Game Top Players in #${channelName}: ${listItems.join(', ')}`;
}

/**
 * Handler for the !geo command and its subcommands.
 */
const geoHandler = {
    name: 'geo',
    description: 'Starts or manages the Geo-Game (!geo help for details).',
    usage: '!geo [<rounds>] | stop | config <options...> | resetconfig | leaderboard | clearleaderboard | report <reason...> | help',
    permission: 'everyone', // Subcommand permissions handled inside
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelName = channel.substring(1);
        const invokingUsernameLower = user.username; // Get lowercase username
        const invokingDisplayName = user['display-name'] || user.username;
        const isModOrBroadcaster = isPrivilegedUser(user, channelName);
        const geoManager = getGeoGameManager(); // Get the manager instance

        let subCommand = args[0]?.toLowerCase();
        let gameMode = 'real'; // Default mode
        let scope = null; // Will hold gameTitle or regionScope
        let numberOfRounds = 1; // Default rounds
        let consumedArgsCount = 0; // Track processed args for start commands

        // Helper function to check if a string is a positive integer
        const isPositiveInteger = (str) => /^[1-9]\d*$/.test(str);

        // --- Subcommand Parsing ---
        if (!subCommand) {
            // !geo -> Start Real World Game (1 round, global scope)
            gameMode = 'real';
            scope = null;
            numberOfRounds = 1;
            consumedArgsCount = 0;
            // Proceed to start game below
        } else if (isPositiveInteger(subCommand)) {
            // !geo <rounds> -> Start Real World Game (<rounds>, global scope)
            gameMode = 'real';
            scope = null;
            numberOfRounds = parseInt(subCommand, 10);
            consumedArgsCount = 1;
             // Proceed to start game below
        } else if (subCommand === 'game') {
            // !geo game [Optional Title] [Optional Rounds]
            gameMode = 'game';
            consumedArgsCount = 1; // Consumed 'game'
            let potentialScopeParts = [];
            let potentialRoundsArg = null;
            let remainingArgs = args.slice(1); // Args after 'game'

            if (remainingArgs.length > 0) {
                // Check if the last argument is a number
                if (isPositiveInteger(remainingArgs[remainingArgs.length - 1])) {
                    potentialRoundsArg = remainingArgs[remainingArgs.length - 1];
                    potentialScopeParts = remainingArgs.slice(0, remainingArgs.length - 1);
                } else {
                    potentialScopeParts = remainingArgs;
                }
            }

            if (potentialScopeParts.length > 0) {
                scope = potentialScopeParts.join(' '); // Specific game title provided
            } else {
                // No title parts, get title from stream context
                try {
                     const contextManager = getContextManager();
                     const llmContext = contextManager.getContextForLLM(channelName, invokingDisplayName, "");
                     scope = llmContext?.streamGame || null;
                     if (!scope || scope === "N/A") {
                         enqueueMessage(channel, `@${invokingDisplayName}, Could not detect the current game. Please specify one: !geo game <Game Title> [rounds]`);
                         return;
                     }
                     logger.info(`[GeoGame] Using current stream game for !geo game: ${scope}`);
                } catch (err) {
                     logger.error({ err }, "Error getting stream context for !geo game");
                     enqueueMessage(channel, `@${invokingDisplayName}, Error getting current stream game.`);
                     return;
                }
            }
            // Set rounds if provided
            if (potentialRoundsArg) {
                numberOfRounds = parseInt(potentialRoundsArg, 10);
            }
            consumedArgsCount = args.length; // All args consumed for this path
             // Proceed to start game below

        } else if (subCommand === 'stop') {
            // !geo stop
            const currentGameInitiator = geoManager.getCurrentGameInitiator(channelName); // Get initiator

            if (!currentGameInitiator) {
                // No active game to stop
                enqueueMessage(channel, `@${invokingDisplayName}, There is no active Geo-Game round to stop.`);
                return;
            }

            // Check permissions
            if (isModOrBroadcaster || invokingUsernameLower === currentGameInitiator) {
                // Allow if user is mod/broadcaster OR if they are the initiator
                geoManager.stopGame(channelName); // Call manager's stop function; manager will send the final message
                logger.info(`[GeoGame] Stop requested by ${invokingDisplayName}, handled by manager.`);
            } else {
                // Deny if not mod/broadcaster AND not the initiator
                enqueueMessage(channel, `@${invokingDisplayName}, Only the game initiator, mods, or the broadcaster can stop the current game.`);
            }
            return; // Action done

        } else if (subCommand === 'config') {
            // !geo config ...
            if (!isModOrBroadcaster) {
                enqueueMessage(channel, `@${invokingDisplayName}, Only mods or the broadcaster can configure the game.`);
                return;
            }
            const options = {};
            for (let i = 1; i < args.length; i += 2) {
                const key = args[i]?.toLowerCase();
                const value = args[i + 1];
                if (!key || !value) continue;

                // --- Existing Options ---
                if (key === 'difficulty' && ['easy', 'normal', 'hard'].includes(value.toLowerCase())) {
                    options.difficulty = value.toLowerCase();
                } else if (['interval', 'clueinterval', 'clueintervalseconds'].includes(key)) {
                    const interval = parseInt(value, 10);
                    if (!isNaN(interval)) options.clueIntervalSeconds = interval;
                } else if (['duration', 'roundduration', 'rounddurationminutes'].includes(key)) {
                    const duration = parseInt(value, 10);
                    if (!isNaN(duration)) options.roundDurationMinutes = duration;
                } else if (key === 'region' || key === 'regions') {
                    options.regionRestrictions = value.split(',').map(s => s.trim()).filter(Boolean);
                } else if (key === 'game' || key === 'gametitle') {
                    options.gameTitlePreferences = value.split(',').map(s => s.trim()).filter(Boolean);
                } else if (key === 'scoring' || key === 'scoretracking') {
                    options.scoreTracking = value.toLowerCase() === 'true' || value === '1';
                }
                // --- NEW Scoring Options ---
                else if (key === 'points' || key === 'basepoints') {
                     const points = parseInt(value, 10);
                     if (!isNaN(points)) options.pointsBase = points;
                 } else if (key === 'timebonus') {
                     options.pointsTimeBonus = value.toLowerCase() === 'true' || value === '1';
                 } else if (key === 'difficultymultiplier') {
                     options.pointsDifficultyMultiplier = value.toLowerCase() === 'true' || value === '1';
                 }
                 // --- End NEW Scoring Options ---
            }
            if (Object.keys(options).length === 0) {
                 // Update usage message
                 enqueueMessage(channel, `@${invokingDisplayName}, Usage: !geo config difficulty <easy|normal|hard> interval <secs> duration <mins> region <list> game <list> scoring <bool> points <num> timebonus <bool> difficultymultiplier <bool>`);
                 return;
            }
            const result = await geoManager.configureGame(channelName, options);
            enqueueMessage(channel, `@${invokingDisplayName}, ${result.message}`);
            return; // Action done

        } else if (subCommand === 'resetconfig') {
            if (!isModOrBroadcaster) {
                enqueueMessage(channel, `@${invokingDisplayName}, Only mods or the broadcaster can reset the game configuration.`);
                return;
            }
            try {
                const result = await geoManager.resetChannelConfig(channelName);
                enqueueMessage(channel, `@${invokingDisplayName}, ${result.message}`);
            } catch (error) {
                logger.error({ err: error, channel: channelName }, 'Error calling resetChannelConfig from command handler.');
                enqueueMessage(channel, `@${invokingDisplayName}, An unexpected error occurred while trying to reset the configuration.`);
            }
            return; // Action done

        } else if (subCommand === 'leaderboard') {
            // !geo leaderboard
            try {
                const leaderboardData = await getLeaderboard(channelName, 5); // Get top 5
                const message = formatLeaderboardMessage(leaderboardData, channelName);
                enqueueMessage(channel, message);
                logger.info(`[GeoGame] Displayed leaderboard for channel ${channelName}`);
            } catch (error) {
                logger.error({ err: error, channel: channelName }, 'Error fetching or formatting leaderboard.');
                enqueueMessage(channel, `@${invokingDisplayName}, Sorry, couldn't fetch the leaderboard right now.`);
            }
            return; // Action done

        } else if (subCommand === 'clearleaderboard' || subCommand === 'resetstats') {
            if (!isModOrBroadcaster) {
                enqueueMessage(channel, `@${invokingDisplayName}, Only mods or the broadcaster can clear the leaderboard.`);
                return;
            }
            enqueueMessage(channel, `@${invokingDisplayName}, Attempting to clear Geo-Game leaderboard data for this channel. This may take a moment...`);
            try {
                const result = await geoManager.clearLeaderboard(channelName);
                enqueueMessage(channel, `@${invokingDisplayName}, ${result.message}`);
            } catch (error) {
                logger.error({ err: error, channel: channelName }, 'Error calling clearLeaderboard from command handler.');
                enqueueMessage(channel, `@${invokingDisplayName}, An unexpected error occurred while trying to clear the leaderboard.`);
            }
            return; // Action done

        } else if (subCommand === 'report' || subCommand === 'flag') {
            // !geo report [reason...]
            if (args.length < 2) {
                enqueueMessage(channel, `@${invokingDisplayName}, Please provide a reason for reporting. Usage: !geo report <your reason>`);
                return;
            }
            const reason = args.slice(1).join(' ');
            logger.info(`[GeoCmd] ${invokingDisplayName} is initiating report for last geo session in ${channelName}. Reason: ${reason}`);
            try {
                const reportInitiationResult = await geoManager.initiateReportProcess(channelName, reason, invokingUsernameLower);
                if (reportInitiationResult.message) {
                    enqueueMessage(channel, `@${invokingDisplayName}, ${reportInitiationResult.message}`);
                } else if (!reportInitiationResult.success) {
                    enqueueMessage(channel, `@${invokingDisplayName}, Could not process your report request at this time.`);
                }
            } catch (error) {
                logger.error({ err: error, channel: channelName, user: invokingUsernameLower }, 'Error calling initiateReportProcess for Geo.');
                enqueueMessage(channel, `@${invokingDisplayName}, An error occurred while trying to initiate the report.`);
            }
            return;

        } else if (subCommand === 'help') {
            // !geo help
            enqueueMessage(channel, `@${invokingDisplayName}, Geo-Game: !geo [region] [rounds] (start real), !geo game [Title] [rounds] (start game), !geo stop (mods/initiator), !geo config <opts...> (mods), !geo resetconfig (mods), !geo leaderboard, !geo clearleaderboard (mods), !geo report <reason...>, !geo help`);
            return; // Action done

        } else {
            // Assume !geo <region text...> [Optional Rounds] -> Real World Game
            gameMode = 'real';
            let potentialScopeParts = [];
            let potentialRoundsArg = null;

            // Check if the last argument is a number
            if (args.length > 0 && isPositiveInteger(args[args.length - 1])) {
                potentialRoundsArg = args[args.length - 1];
                potentialScopeParts = args.slice(0, args.length - 1);
            } else {
                potentialScopeParts = args.slice(0); // All args are part of the scope
            }

            if (potentialScopeParts.length > 0) {
                 scope = potentialScopeParts.join(' '); // User-defined region scope
                 logger.info(`[GeoGame] Interpreting '!geo ${args.join(' ')}' as starting real mode (Region: '${scope}') for ${numberOfRounds} round(s).`);
            } else {
                 // Should not happen if args.length > 0 and first arg wasn't a number or known subcommand
                 // but handle defensively. This implies `!geo` with no args, handled above.
                 logger.warn(`[GeoGame] Parser reached real-world scope interpretation unexpectedly for args: ${args.join(' ')}`);
                 scope = null; // Fallback to global scope
            }

            if (potentialRoundsArg) {
                numberOfRounds = parseInt(potentialRoundsArg, 10);
            }
            consumedArgsCount = args.length; // All args consumed
            // Proceed to start game below
        }


        // --- Start Game Section (Common for 'real' and 'game' modes determined above) ---

        // If consumedArgsCount is less than args.length, it means some arguments were not processed by any logic path above,
        // implying an unknown command format or subcommand was attempted after a valid start sequence initiator.
        if (consumedArgsCount < args.length) {
            logger.warn(`[GeoGame][${channelName}] Unknown arguments after primary command processing: ${args.slice(consumedArgsCount).join(' ')}`);
            enqueueMessage(channel, `@${invokingDisplayName}, Unknown command format or extra arguments provided. Use !geo help.`);
            return;
        }

        // Validate number of rounds (e.g., max 10)
        const MAX_ROUNDS = 10;
        if (numberOfRounds > MAX_ROUNDS) {
             enqueueMessage(channel, `@${invokingDisplayName}, Maximum number of rounds is ${MAX_ROUNDS}. Starting a ${MAX_ROUNDS}-round game.`);
             numberOfRounds = MAX_ROUNDS;
        }

        // Now, call the startGame function with the determined parameters
        try {
            logger.info(`Attempting to start Geo-Game. Mode: ${gameMode}, Scope: ${scope || 'N/A'}, Rounds: ${numberOfRounds}, Initiator: ${invokingUsernameLower}`);
            // Pass the determined scope (which is either gameTitle or regionScope)
            const result = await geoManager.startGame(channelName, gameMode, scope, invokingUsernameLower, numberOfRounds);

            if (!result.success) {
                enqueueMessage(channel, `@${invokingDisplayName}, ${result.error}`);
            }
            // Success messages are handled by the game manager
        } catch (error) {
            logger.error({ err: error }, "Unhandled error starting game from command handler.");
            enqueueMessage(channel, `@${invokingDisplayName}, An unexpected error occurred trying to start the game.`);
        }
    }
};

export default geoHandler;