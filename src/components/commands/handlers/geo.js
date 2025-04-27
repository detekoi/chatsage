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

    // Sort by channel wins specifically, just in case the storage layer didn't
    // (though it should have)
    leaderboardData.sort((a, b) => (b.data?.channelWins || 0) - (a.data?.channelWins || 0));

    const topPlayers = leaderboardData.slice(0, 5); // Show top 5

    const listItems = topPlayers.map((player, index) => {
        const rank = index + 1;
        const name = player.data?.displayName || player.id;
        const wins = player.data?.channelWins || 0;
        // Optional: Add participation - const participation = player.data?.channelParticipation || 0;
        return `${rank}. ${name} (${wins} wins)`;
    });

    return `🏆 Geo-Game Top Players in #${channelName}: ${listItems.join(', ')}`;
}

/**
 * Handler for the !geo command and its subcommands.
 */
const geoHandler = {
    name: 'geo',
    description: 'Starts or manages the Geo-Game (!geo help for details).',
    usage: '!geo [<game> [Game Title]] | stop | config | leaderboard | help',
    permission: 'everyone', // Subcommand permissions handled inside
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelName = channel.substring(1);
        const invokingDisplayName = user['display-name'] || user.username;
        const isModOrBroadcaster = isPrivilegedUser(user, channelName);
        const geoManager = getGeoGameManager(); // Get the manager instance

        let subCommand = args[0]?.toLowerCase();
        let gameMode = 'real'; // Default to real world
        let gameTitle = null;

        // --- Subcommand Parsing ---
        if (!subCommand) {
            // !geo -> Start Real World Game
            gameMode = 'real';
        } else if (subCommand === 'stop') {
            // !geo stop
            if (!isModOrBroadcaster) {
                enqueueMessage(channel, `@${invokingDisplayName}, Only mods or the broadcaster can stop the game.`);
                return;
            }
            const result = geoManager.stopGame(channelName); // Call manager's stop function
            enqueueMessage(channel, `@${invokingDisplayName}, ${result.message}`);
            return; // Action done

        } else if (subCommand === 'config') {
            // !geo config ...
            if (!isModOrBroadcaster) {
                enqueueMessage(channel, `@${invokingDisplayName}, Only mods or the broadcaster can configure the game.`);
                return;
            }
            // Parse config args (e.g., !geo config difficulty hard, !geo config interval 90, !geo config duration 10)
            const options = {};
            for (let i = 1; i < args.length; i += 2) {
                const key = args[i]?.toLowerCase();
                const value = args[i + 1];
                if (!key || !value) continue;
                if (key === 'difficulty' && ['easy', 'normal', 'hard'].includes(value.toLowerCase())) {
                    options.difficulty = value.toLowerCase();
                } else if (['interval', 'clueinterval', 'clueintervalseconds'].includes(key)) {
                    const interval = parseInt(value, 10);
                    if (!isNaN(interval)) options.clueIntervalSeconds = interval;
                } else if (['duration', 'roundduration', 'rounddurationminutes'].includes(key)) {
                    const duration = parseInt(value, 10);
                    if (!isNaN(duration)) options.roundDurationMinutes = duration;
                } else if (key === 'region' || key === 'regions') {
                    // Allow comma-separated list
                    options.regionRestrictions = value.split(',').map(s => s.trim()).filter(Boolean);
                } else if (key === 'game' || key === 'gametitle') {
                    options.gameTitlePreferences = value.split(',').map(s => s.trim()).filter(Boolean);
                }
            }
            if (Object.keys(options).length === 0) {
                enqueueMessage(channel, `@${invokingDisplayName}, Usage: !geo config difficulty <easy|normal|hard> interval <seconds> duration <minutes> region <list> game <list>`);
                return;
            }
            const result = geoManager.configureGame(channelName, options); // Call manager's config function
            enqueueMessage(channel, `@${invokingDisplayName}, ${result.message}`);
            return; // Action done

        } else if (subCommand === 'leaderboard') {
            // !geo leaderboard
            try {
                // Fetch channel-specific leaderboard data from storage
                // Use channelName (without #)
                const leaderboardData = await getLeaderboard(channelName, 5); // Get top 5
                const message = formatLeaderboardMessage(leaderboardData, channelName);
                enqueueMessage(channel, message);
                logger.info(`[GeoGame] Displayed leaderboard for channel ${channelName}`);
            } catch (error) {
                logger.error({ err: error, channel: channelName }, 'Error fetching or formatting leaderboard.');
                enqueueMessage(channel, `@${invokingDisplayName}, Sorry, couldn't fetch the leaderboard right now.`);
            }
            return; // Action done
            
        } else if (subCommand === 'help') {
            // !geo help
            enqueueMessage(channel, `@${invokingDisplayName}, Geo-Game commands: !geo (real world), !geo game (current stream game), !geo game [Title], !geo stop (mods), !geo config (mods), !geo leaderboard, !geo help`);
            return; // Action done

        } else if (subCommand === 'game') {
            // !geo game [Optional Title]
            gameMode = 'game';
            if (args.length > 1) {
                gameTitle = args.slice(1).join(' '); // Specific title provided
            } else {
                // Get title from stream context
                try {
                     const contextManager = getContextManager();
                     // Provide dummy user/message for context getter if needed
                     const llmContext = contextManager.getContextForLLM(channelName, invokingDisplayName, "");
                     gameTitle = llmContext?.streamGame || null;
                     if (!gameTitle || gameTitle === "N/A") {
                         enqueueMessage(channel, `@${invokingDisplayName}, Could not detect the current game. Please specify one: !geo game [Game Title]`);
                         return;
                     }
                     logger.info(`[GeoGame] Using current stream game for !geo game: ${gameTitle}`);
                } catch (err) {
                     logger.error({ err }, "Error getting stream context for !geo game");
                     enqueueMessage(channel, `@${invokingDisplayName}, Error getting current stream game.`);
                     return;
                }
            }
        } else {
            // Assume !geo <some game title directly> - Treat as Video Game Mode start
            // This might be ambiguous if a game title is "stop", "config", "help" or "game" - could refine later
            gameMode = 'game';
            gameTitle = args.join(' ');
             logger.info(`[GeoGame] Interpreting '!geo ${gameTitle}' as starting game mode.`);
        }

        // --- Start Game ---
        // If we reach here, it's a start game request (real or game)
        try {
            logger.info(`Attempting to start Geo-Game. Mode: ${gameMode}, Title: ${gameTitle || 'N/A'}`);
            const result = await geoManager.startGame(channelName, gameMode, gameTitle);
            // Send result message (success or failure reason)
            enqueueMessage(channel, `@${invokingDisplayName}, ${result.message || result.error}`);
        } catch (error) {
            logger.error({ err: error }, "Unhandled error starting game from command handler.");
            enqueueMessage(channel, `@${invokingDisplayName}, An unexpected error occurred trying to start the game.`);
        }
    }
};

export default geoHandler;