// src/components/commands/handlers/trivia.js
import logger from '../../../lib/logger.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { getTriviaGameManager } from '../../trivia/triviaGameManager.js';
import { getLeaderboard } from '../../trivia/triviaStorage.js';
import { formatHelpMessage } from '../../trivia/triviaMessageFormatter.js';
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
    isPositiveInteger,
} from './gameHandlerUtils.js';

const GAME_NAME = 'Trivia';
const COMMAND_NAME = 'trivia';

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
        const correct = player.data?.channelSuccesses || 0;
        return `${rank}. ${name} (${points} pts, ${correct} correct)`;
    });

    return `🏆 Trivia Champions in #${channelName}: ${listItems.join(', ')}`;
}

/**
 * Config schema for trivia game options.
 * Used by handleConfig to parse key-value pairs from args.
 */
const TRIVIA_CONFIG_SCHEMA = [
    { keys: ['difficulty'], type: 'enum', optionName: 'difficulty', enumValues: ['easy', 'normal', 'hard'] },
    { keys: ['time', 'questiontime', 'questiontimeseconds'], type: 'int', optionName: 'questionTimeSeconds' },
    { keys: ['duration', 'roundduration', 'rounddurationminutes'], type: 'int', optionName: 'roundDurationMinutes' },
    { keys: ['topic', 'topics'], type: 'list', optionName: 'topicPreferences' },
    { keys: ['scoring', 'scoretracking'], type: 'bool', optionName: 'scoreTracking' },
    { keys: ['points', 'basepoints'], type: 'int', optionName: 'pointsBase' },
    { keys: ['timebonus'], type: 'bool', optionName: 'pointsTimeBonus' },
    { keys: ['difficultymultiplier'], type: 'bool', optionName: 'pointsDifficultyMultiplier' },
];

const TRIVIA_CONFIG_USAGE = `Usage: !trivia config difficulty <easy|normal|hard> time <seconds> duration <minutes> topic <list> scoring <true|false> points <value> timebonus <true|false> difficultymultiplier <true|false>`;

/**
 * Handler for the !trivia command and its subcommands.
 */
const trivia = {
    name: 'trivia',
    description: 'Starts or manages a Trivia game (!trivia help for details).',
    usage: '!trivia [<rounds>] | [topic] [rounds] | [rounds] [topic] | game [rounds] | stop | config <options...> | resetconfig | leaderboard | clearleaderboard | help',
    permission: 'everyone', // Subcommand permissions handled inside
    execute: async (context) => {
        const gameCtx = extractGameContext(context);
        const { channel, channelName, username, replyToId, isMod, args } = gameCtx;
        const triviaManager = getTriviaGameManager();

        let subCommand = args[0]?.toLowerCase();
        let topic;
        let numberOfRounds = 1;

        // --- Subcommand Routing ---
        if (!subCommand) {
            // !trivia -> Start general knowledge game (1 round)
            topic = null;
            numberOfRounds = 1;
            // Proceed to start game below
        } else if (isPositiveInteger(subCommand)) {
            // !trivia <rounds> [topic...] -> Start game with specified rounds (and optional topic)
            numberOfRounds = parseInt(subCommand, 10);
            if (args.length > 1) {
                topic = args.slice(1).join(' ');
            } else {
                topic = null;
            }
            // Proceed to start game below
        } else if (subCommand === 'game') {
            // !trivia game [rounds] -> Start a game based on current stream game
            topic = 'game'; // Special keyword, will be resolved by game manager

            if (args.length > 1 && isPositiveInteger(args[1])) {
                numberOfRounds = parseInt(args[1], 10);
            }
            // Proceed to start game below

        } else if (subCommand === 'stop') {
            await handleStop(gameCtx, triviaManager, GAME_NAME);
            return;

        } else if (subCommand === 'config') {
            await handleConfig(gameCtx, triviaManager, TRIVIA_CONFIG_SCHEMA, TRIVIA_CONFIG_USAGE, GAME_NAME);
            return;

        } else if (subCommand === 'resetconfig') {
            await handleResetConfig(gameCtx, triviaManager, GAME_NAME);
            return;

        } else if (subCommand === 'leaderboard') {
            await handleLeaderboard(gameCtx, getLeaderboard, formatLeaderboardMessage, GAME_NAME);
            return;

        } else if (subCommand === 'clearleaderboard' || subCommand === 'resetstats') {
            await handleClearLeaderboard(gameCtx, triviaManager, GAME_NAME);
            return;

        } else if (subCommand === 'report' || subCommand === 'flag') {
            await handleReport(gameCtx, triviaManager, GAME_NAME, COMMAND_NAME);
            return;

        } else if (subCommand === 'help') {
            const helpMessage = formatHelpMessage(isMod);
            await enqueueMessage(channel, `${helpMessage}`, { replyToId });
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
        numberOfRounds = await validateRounds(gameCtx, numberOfRounds, 10);

        // Start the game
        logger.info(`Attempting to start Trivia game. Topic: ${topic || 'General'}, Rounds: ${numberOfRounds}, Initiator: ${username}`);
        await startGameWithErrorHandling(gameCtx,
            () => triviaManager.startGame(channelName, topic, username, numberOfRounds),
            GAME_NAME
        );
    }
};

export default trivia;