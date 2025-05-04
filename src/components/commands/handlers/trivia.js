// src/components/commands/handlers/trivia.js
import logger from '../../../lib/logger.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { getTriviaGameManager } from '../../trivia/triviaGameManager.js';
import { getContextManager } from '../../context/contextManager.js';
import { getLeaderboard } from '../../trivia/triviaStorage.js';
import { formatHelpMessage, formatGameSessionScoresMessage } from '../../trivia/triviaMessageFormatter.js';

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
        return `No Trivia stats found for this channel (${channelName}) yet!`;
    }

    // Sort by points
    leaderboardData.sort((a, b) => (b.data?.channelPoints || 0) - (a.data?.channelPoints || 0));

    const topPlayers = leaderboardData.slice(0, 5); // Show top 5

    const listItems = topPlayers.map((player, index) => {
        const rank = index + 1;
        const name = player.data?.displayName || player.id;
        const points = player.data?.channelPoints || 0;
        const correct = player.data?.channelCorrect || 0;
        return `${rank}. ${name} (${points} pts, ${correct} correct)`;
    });

    return `🏆 Trivia Champions in #${channelName}: ${listItems.join(', ')}`;
}

/**
 * Handler for the !trivia command and its subcommands.
 */
const trivia = {
    name: 'trivia',
    description: 'Starts or manages a Trivia game (!trivia help for details).',
    usage: '!trivia [<rounds>] | [topic] [rounds] | game [rounds] | stop | config <options...> | resetconfig | leaderboard | clearleaderboard | help',
    permission: 'everyone', // Subcommand permissions handled inside
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelName = channel.substring(1);
        const invokingUsernameLower = user.username;
        const invokingDisplayName = user['display-name'] || user.username;
        const isModOrBroadcaster = isPrivilegedUser(user, channelName);
        const triviaManager = getTriviaGameManager();

        let subCommand = args[0]?.toLowerCase();
        let topic = null;
        let numberOfRounds = 1;
        
        // Helper function to check if a string is a positive integer
        const isPositiveInteger = (str) => /^[1-9]\d*$/.test(str);

        // --- Subcommand Parsing ---
        if (!subCommand) {
            // !trivia -> Start general knowledge game (1 round)
            topic = null;
            numberOfRounds = 1;
            // Proceed to start game below
        } else if (isPositiveInteger(subCommand)) {
            // !trivia <rounds> -> Start general knowledge game with specified rounds
            topic = null;
            numberOfRounds = parseInt(subCommand, 10);
            // Proceed to start game below
        } else if (subCommand === 'game') {
            // !trivia game [rounds] -> Start a game based on current stream game
            topic = 'game';
            
            // Check if there's a rounds parameter
            if (args.length > 1 && isPositiveInteger(args[1])) {
                numberOfRounds = parseInt(args[1], 10);
            }
            
            // Proceed to start game below
        } else if (subCommand === 'stop') {
            // !trivia stop -> Stop the current game
            const currentGameInitiator = triviaManager.getCurrentGameInitiator(channelName);

            if (!currentGameInitiator) {
                enqueueMessage(channel, `@${invokingDisplayName}, There is no active Trivia game to stop.`);
                return;
            }

            // Check permissions
            if (isModOrBroadcaster || invokingUsernameLower === currentGameInitiator) {
                const result = triviaManager.stopGame(channelName);
                logger.info(`[Trivia] Stop requested by ${invokingDisplayName}, result: ${result.message}`);
            } else {
                enqueueMessage(channel, `@${invokingDisplayName}, Only the game initiator, mods, or the broadcaster can stop the current game.`);
            }
            return;
        } else if (subCommand === 'config') {
            // !trivia config ... -> Configure game settings
            if (!isModOrBroadcaster) {
                enqueueMessage(channel, `@${invokingDisplayName}, Only mods or the broadcaster can configure the game.`);
                return;
            }
            
            // Parse config options
            const options = {};
            for (let i = 1; i < args.length; i += 2) {
                const key = args[i]?.toLowerCase();
                const value = args[i + 1];
                
                if (!key || !value) continue;
                
                if (key === 'difficulty' && ['easy', 'normal', 'hard'].includes(value.toLowerCase())) {
                    options.difficulty = value.toLowerCase();
                } else if (['time', 'questiontime', 'questiontimeseconds'].includes(key)) {
                    const time = parseInt(value, 10);
                    if (!isNaN(time)) options.questionTimeSeconds = time;
                } else if (['duration', 'roundduration', 'rounddurationminutes'].includes(key)) {
                    const duration = parseInt(value, 10);
                    if (!isNaN(duration)) options.roundDurationMinutes = duration;
                } else if (key === 'topic' || key === 'topics') {
                    options.topicPreferences = value.split(',').map(s => s.trim()).filter(Boolean);
                } else if (key === 'scoring' || key === 'scoretracking') {
                    options.scoreTracking = value.toLowerCase() === 'true' || value === '1';
                } else if (key === 'points' || key === 'basepoints') {
                    const points = parseInt(value, 10);
                    if (!isNaN(points)) options.pointsBase = points;
                } else if (key === 'timebonus') {
                    options.pointsTimeBonus = value.toLowerCase() === 'true' || value === '1';
                } else if (key === 'difficultymultiplier') {
                    options.pointsDifficultyMultiplier = value.toLowerCase() === 'true' || value === '1';
                }
            }
            
            if (Object.keys(options).length === 0) {
                enqueueMessage(channel, `@${invokingDisplayName}, Usage: !trivia config difficulty <easy|normal|hard> time <seconds> duration <minutes> topic <list> scoring <true|false> points <value> timebonus <true|false> difficultymultiplier <true|false>`);
                return;
            }
            
            const result = await triviaManager.configureGame(channelName, options);
            enqueueMessage(channel, `@${invokingDisplayName}, ${result.message}`);
            return;
        } else if (subCommand === 'resetconfig') {
            // !trivia resetconfig -> Reset game configuration to defaults
            if (!isModOrBroadcaster) {
                enqueueMessage(channel, `@${invokingDisplayName}, Only mods or the broadcaster can reset the game configuration.`);
                return;
            }
            
            try {
                const result = await triviaManager.resetChannelConfig(channelName);
                enqueueMessage(channel, `@${invokingDisplayName}, ${result.message}`);
            } catch (error) {
                logger.error({ err: error, channel: channelName }, 'Error calling resetChannelConfig from trivia handler.');
                enqueueMessage(channel, `@${invokingDisplayName}, An unexpected error occurred while trying to reset the configuration.`);
            }
            return;
        } else if (subCommand === 'leaderboard') {
            // !trivia leaderboard -> Show the leaderboard
            try {
                const leaderboardData = await getLeaderboard(channelName, 5);
                const message = formatLeaderboardMessage(leaderboardData, channelName);
                enqueueMessage(channel, message);
                logger.info(`[Trivia] Displayed leaderboard for channel ${channelName}`);
            } catch (error) {
                logger.error({ err: error, channel: channelName }, 'Error fetching or formatting trivia leaderboard.');
                enqueueMessage(channel, `@${invokingDisplayName}, Sorry, couldn't fetch the leaderboard right now.`);
            }
            return;
        } else if (subCommand === 'clearleaderboard' || subCommand === 'resetstats') {
            // !trivia clearleaderboard -> Clear the leaderboard
            if (!isModOrBroadcaster) {
                enqueueMessage(channel, `@${invokingDisplayName}, Only mods or the broadcaster can clear the leaderboard.`);
                return;
            }
            
            enqueueMessage(channel, `@${invokingDisplayName}, Attempting to clear Trivia leaderboard data for this channel. This may take a moment...`);
            
            try {
                const result = await triviaManager.clearLeaderboard(channelName);
                enqueueMessage(channel, `@${invokingDisplayName}, ${result.message}`);
            } catch (error) {
                logger.error({ err: error, channel: channelName }, 'Error calling clearLeaderboard from trivia handler.');
                enqueueMessage(channel, `@${invokingDisplayName}, An unexpected error occurred while trying to clear the leaderboard.`);
            }
            return;
        } else if (subCommand === 'help') {
            // !trivia help -> Show help information
            const helpMessage = formatHelpMessage(isModOrBroadcaster);
            enqueueMessage(channel, `@${invokingDisplayName}, ${helpMessage}`);
            return;
        } else {
            // !trivia <topic> [rounds] -> Start a topic-specific game
            topic = subCommand;
            
            // Check if there's a rounds parameter at the end
            if (args.length > 1 && isPositiveInteger(args[args.length - 1])) {
                numberOfRounds = parseInt(args[args.length - 1], 10);
                
                // If there are args in between, they're part of the topic
                if (args.length > 2) {
                    topic = args.slice(0, args.length - 1).join(' ');
                }
            } else if (args.length > 1) {
                // Multiple words for topic, no rounds
                topic = args.join(' ');
            }
            
            // Proceed to start game below
        }

        // --- Game Start Logic (Common for all start variations) ---
        
        // Validate number of rounds
        const MAX_ROUNDS = 10;
        if (numberOfRounds > MAX_ROUNDS) {
            enqueueMessage(channel, `@${invokingDisplayName}, Maximum number of rounds is ${MAX_ROUNDS}. Starting a ${MAX_ROUNDS}-round game.`);
            numberOfRounds = MAX_ROUNDS;
        }
        
        // Start the game
        try {
            logger.info(`Attempting to start Trivia game. Topic: ${topic || 'General'}, Rounds: ${numberOfRounds}, Initiator: ${invokingUsernameLower}`);
            
            const result = await triviaManager.startGame(channelName, topic, invokingUsernameLower, numberOfRounds);
            
            if (!result.success) {
                enqueueMessage(channel, `@${invokingDisplayName}, ${result.error}`);
            }
            // Success messages are handled by the game manager
        } catch (error) {
            logger.error({ err: error }, "Unhandled error starting trivia game from command handler.");
            enqueueMessage(channel, `@${invokingDisplayName}, An unexpected error occurred trying to start the game.`);
        }
    }
};

export default trivia;