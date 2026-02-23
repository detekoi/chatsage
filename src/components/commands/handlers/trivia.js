// src/components/commands/handlers/trivia.js
import logger from '../../../lib/logger.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { getTriviaGameManager } from '../../trivia/triviaGameManager.js';

import { getLeaderboard } from '../../trivia/triviaStorage.js';
import { formatHelpMessage } from '../../trivia/triviaMessageFormatter.js';

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
    usage: '!trivia [<rounds>] | [topic] [rounds] | [rounds] [topic] | game [rounds] | stop | config <options...> | resetconfig | leaderboard | clearleaderboard | help',
    permission: 'everyone', // Subcommand permissions handled inside
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelName = channel.substring(1);
        const invokingUsernameLower = user.username;
        const invokingDisplayName = user['display-name'] || user.username;
        const replyToId = user?.id || user?.['message-id'] || null;
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
            // !trivia <rounds> [topic...] -> Start game with specified rounds (and optional topic)
            numberOfRounds = parseInt(subCommand, 10);
            if (args.length > 1) {
                // e.g. "!trivia 3 animals" or "!trivia 3 90s music"
                topic = args.slice(1).join(' ');
            } else {
                topic = null;
            }
            // Proceed to start game below
        } else if (subCommand === 'game') {
            // !trivia game [rounds] -> Start a game based on current stream game
            topic = 'game'; // Special keyword, will be resolved by game manager

            // Check if there's a rounds parameter
            if (args.length > 1 && isPositiveInteger(args[1])) {
                numberOfRounds = parseInt(args[1], 10);
            }

            // Proceed to start game below
        } else if (subCommand === 'stop') {
            // !trivia stop -> Stop the current game
            const currentGameInitiator = triviaManager.getCurrentGameInitiator(channelName);

            if (!currentGameInitiator) {
                enqueueMessage(channel, `There is no active Trivia game to stop.`, { replyToId });
                return;
            }

            // Check permissions
            if (isModOrBroadcaster || invokingUsernameLower === currentGameInitiator) {
                const result = triviaManager.stopGame(channelName);
                logger.info(`[Trivia] Stop requested by ${invokingDisplayName}, result: ${result.message}`);
                // Message to chat is handled by stopGame/transitionToEnding
            } else {
                enqueueMessage(channel, `Only the game initiator, mods, or the broadcaster can stop the current game.`, { replyToId });
            }
            return;
        } else if (subCommand === 'config') {
            // !trivia config ... -> Configure game settings
            if (!isModOrBroadcaster) {
                enqueueMessage(channel, `Only mods or the broadcaster can configure the game.`, { replyToId });
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
                enqueueMessage(channel, `Usage: !trivia config difficulty <easy|normal|hard> time <seconds> duration <minutes> topic <list> scoring <true|false> points <value> timebonus <true|false> difficultymultiplier <true|false>`, { replyToId });
                return;
            }

            const result = await triviaManager.configureGame(channelName, options);
            enqueueMessage(channel, `${result.message}`, { replyToId });
            return;
        } else if (subCommand === 'resetconfig') {
            // !trivia resetconfig -> Reset game configuration to defaults
            if (!isModOrBroadcaster) {
                enqueueMessage(channel, `Only mods or the broadcaster can reset the game configuration.`, { replyToId });
                return;
            }

            try {
                const result = await triviaManager.resetChannelConfig(channelName);
                enqueueMessage(channel, `${result.message}`, { replyToId });
            } catch (error) {
                logger.error({ err: error, channel: channelName }, 'Error calling resetChannelConfig from trivia handler.');
                enqueueMessage(channel, `An unexpected error occurred while trying to reset the configuration.`, { replyToId });
            }
            return;
        } else if (subCommand === 'leaderboard') {
            // !trivia leaderboard -> Show the leaderboard
            try {
                const leaderboardData = await getLeaderboard(channelName, 5);
                const message = formatLeaderboardMessage(leaderboardData, channelName);
                enqueueMessage(channel, message, { replyToId });
                logger.info(`[Trivia] Displayed leaderboard for channel ${channelName}`);
            } catch (error) {
                logger.error({ err: error, channel: channelName }, 'Error fetching or formatting trivia leaderboard.');
                enqueueMessage(channel, `Sorry, couldn't fetch the leaderboard right now.`, { replyToId });
            }
            return;
        } else if (subCommand === 'clearleaderboard' || subCommand === 'resetstats') {
            // !trivia clearleaderboard -> Clear the leaderboard
            if (!isModOrBroadcaster) {
                enqueueMessage(channel, `Only mods or the broadcaster can clear the leaderboard.`, { replyToId });
                return;
            }

            enqueueMessage(channel, `Attempting to clear Trivia leaderboard data for this channel. This may take a moment...`, { replyToId });

            try {
                const result = await triviaManager.clearLeaderboard(channelName);
                enqueueMessage(channel, `${result.message}`, { replyToId });
            } catch (error) {
                logger.error({ err: error, channel: channelName }, 'Error calling clearLeaderboard from trivia handler.');
                enqueueMessage(channel, `An unexpected error occurred while trying to clear the leaderboard.`, { replyToId });
            }
            return;
        } else if (subCommand === 'report' || subCommand === 'flag') {
            // !trivia report [reason...]
            if (args.length < 2) {
                enqueueMessage(channel, `Please provide a reason for reporting. Usage: !trivia report <your reason>`, { replyToId });
                return;
            }
            const reason = args.slice(1).join(' ');
            logger.info(`[TriviaCmd] ${invokingDisplayName} is initiating report for last trivia session in ${channelName}. Reason: ${reason}`);
            try {
                const reportInitiationResult = await triviaManager.initiateReportProcess(channelName, reason, invokingUsernameLower);
                if (reportInitiationResult.message) {
                    enqueueMessage(channel, `${reportInitiationResult.message}`, { replyToId });
                } else if (!reportInitiationResult.success) {
                    enqueueMessage(channel, `Could not process your report request at this time.`, { replyToId });
                }
            } catch (error) {
                logger.error({ err: error, channel: channelName, user: invokingUsernameLower }, 'Error calling initiateReportProcess for Trivia.');
                enqueueMessage(channel, `An error occurred while trying to initiate the report.`, { replyToId });
            }
            return;
        } else if (subCommand === 'help') {
            // !trivia help -> Show help information
            const helpMessage = formatHelpMessage(isModOrBroadcaster);
            enqueueMessage(channel, `${helpMessage}`, { replyToId });
            return;
        } else {
            // !trivia <topic> [rounds] -> Start a topic-specific game
            topic = subCommand; // args[0]

            if (args.length > 1 && isPositiveInteger(args[args.length - 1])) {
                numberOfRounds = parseInt(args[args.length - 1], 10);
                if (args.length > 2) { // Topic has multiple words
                    topic = args.slice(0, args.length - 1).join(' ');
                }
                // If args.length is 2 (e.g. topic 3), topic remains args[0]
            } else if (args.length > 1) { // All remaining args are part of the topic
                topic = args.join(' ');
            }
            // Proceed to start game below
        }

        // --- Game Start Logic (Common for all start variations) ---

        // MODIFICATION: Clean topic string by removing leading/trailing quotes
        if (topic && typeof topic === 'string') {
            topic = topic.replace(/^"|"$/g, '');
            logger.debug(`Cleaned topic to: "${topic}"`);
        }
        // END MODIFICATION

        // Validate number of rounds
        const MAX_ROUNDS = 10; // Example max
        if (numberOfRounds > MAX_ROUNDS) {
            enqueueMessage(channel, `Maximum number of rounds is ${MAX_ROUNDS}. Starting a ${MAX_ROUNDS}-round game.`, { replyToId });
            numberOfRounds = MAX_ROUNDS;
        }

        // Start the game
        try {
            logger.info(`Attempting to start Trivia game. Topic: ${topic || 'General'}, Rounds: ${numberOfRounds}, Initiator: ${invokingUsernameLower}`);

            const result = await triviaManager.startGame(channelName, topic, invokingUsernameLower, numberOfRounds);

            if (!result.success) {
                enqueueMessage(channel, `${result.error}`, { replyToId });
            }
            // Success messages are handled by the game manager through its own enqueueMessage calls
        } catch (error) {
            logger.error({ err: error }, "Unhandled error starting trivia game from command handler.");
            enqueueMessage(channel, `An unexpected error occurred trying to start the game.`, { replyToId });
        }
    }
};

export default trivia;