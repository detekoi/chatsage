// src/components/commands/handlers/riddle.js
import logger from '../../../lib/logger.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { getRiddleGameManager } from '../../riddle/riddleGameManager.js';
import { getLeaderboard } from '../../riddle/riddleStorage.js'; // Direct import for leaderboard
import { formatRiddleHelpMessage, formatRiddleLeaderboardMessage } from '../../riddle/riddleMessageFormatter.js';
import config from '../../../config/index.js'; // For bot's username
import { isPrivilegedUser } from '../../../lib/permissions.js';

// Helper to check if a string is a positive integer
const isPositiveInteger = (str) => /^[1-9]\d*$/.test(str);

const riddleHandler = {
    name: 'riddle',
    description: 'Starts or manages a Riddle game. Use !riddle help for more info.',
    usage: '!riddle [<subject>] [<rounds>] | stop | leaderboard | clearleaderboard | report <reason...> | help',
    permission: 'everyone', // Subcommand permissions are handled internally
    execute: async (context) => {
        const { channel, user, args } = context; // channel has #
        const channelNameNoHash = channel.substring(1);
        const invokingUsernameLower = user.username.toLowerCase();
        const invokingDisplayName = user['display-name'] || user.username;
        const replyToId = user?.id || user?.['message-id'] || null;
        const isMod = isPrivilegedUser(user, channelNameNoHash);

        const riddleManager = getRiddleGameManager();

        if (args.length === 0) {
            // !riddle - Start a game, topic will be determined by manager (e.g., current game or general)
            logger.info(`[RiddleCmd] Attempting to start default riddle game in ${channelNameNoHash} by ${invokingDisplayName}`);
            const result = await riddleManager.startGame(channelNameNoHash, null, invokingUsernameLower, 1);
            if (!result.success && result.error) {
                await enqueueMessage(channel, `${result.error}`, { replyToId });
            }
            return;
        }

        const subCommand = args[0].toLowerCase();
        let topic;
        let numberOfRounds = 1;

        switch (subCommand) {
            case 'stop': {
                if (!isMod && invokingUsernameLower !== riddleManager.getCurrentGameInitiator(channelNameNoHash)) {
                    await enqueueMessage(channel, `Only the game initiator, mods, or the broadcaster can stop the riddle game.`, { replyToId });
                    return;
                }
                // Prevent stopping the bot itself if by some chance its name is passed
                if (args[1] && args[1].toLowerCase() === config.twitch.username.toLowerCase()){
                     await enqueueMessage(channel, `I can't stop myself!`, { replyToId });
                    return;
                }

                const stopResult = riddleManager.stopGame(channelNameNoHash);
                // Message to chat is handled by stopGame/transitionToEnding, but provide direct feedback too.
                await enqueueMessage(channel, `${stopResult.message}`, { replyToId });
                logger.info(`[RiddleCmd] Riddle game stop requested by ${invokingDisplayName} in ${channelNameNoHash}. Result: ${stopResult.message}`);
                break;
            }

            case 'leaderboard': {
                try {
                    const leaderboardData = await getLeaderboard(channelNameNoHash, 5);
                    const message = formatRiddleLeaderboardMessage(leaderboardData, channelNameNoHash);
                    await enqueueMessage(channel, message, { replyToId });
                } catch (error) {
                    logger.error({ err: error, channel: channelNameNoHash }, '[RiddleCmd] Error fetching riddle leaderboard.');
                    try {
                        await enqueueMessage(channel, `Sorry, couldn't fetch the riddle leaderboard right now.`, { replyToId });
                    } catch (msgError) {
                        logger.warn({ err: msgError }, '[RiddleCmd] Failed to send error message to chat');
                    }
                }
                break;
            }

            case 'clearleaderboard':
            case 'cleardata': {
                if (!isMod) {
                    await enqueueMessage(channel, `Only mods or the broadcaster can clear the riddle leaderboard.`, { replyToId });
                    return;
                }
                await enqueueMessage(channel, `Attempting to clear Riddle leaderboard data for this channel...`, { replyToId });
                try {
                    const clearResult = await riddleManager.clearLeaderboard(channelNameNoHash);
                    await enqueueMessage(channel, `${clearResult.message}`, { replyToId });
                } catch (error) {
                    logger.error({ err: error, channel: channelNameNoHash }, '[RiddleCmd] Error clearing riddle leaderboard.');
                    try {
                        await enqueueMessage(channel, `An error occurred while clearing the riddle leaderboard.`, { replyToId });
                    } catch (msgError) {
                        logger.warn({ err: msgError }, '[RiddleCmd] Failed to send error message to chat');
                    }
                }
                break;
            }

            case 'report':
            case 'flag': {
                if (args.length < 2) {
                    await enqueueMessage(channel, `Please provide a reason for reporting. Usage: !riddle report <your reason>`, { replyToId });
                    return;
                }
                const reason = args.slice(1).join(' ');
                logger.info(`[RiddleCmd] ${invokingDisplayName} is initiating report for last riddle session in ${channelNameNoHash}. Reason: ${reason}`);
                const reportInitiationResult = await riddleManager.initiateReportProcess(channelNameNoHash, reason, invokingUsernameLower);
                if (reportInitiationResult.message) {
                    await enqueueMessage(channel, `${reportInitiationResult.message}`, { replyToId });
                }
                break;
            }

            case 'help': {
                const helpMessage = formatRiddleHelpMessage(isMod);
                await enqueueMessage(channel, `${helpMessage}`, { replyToId });
                break;
            }

            default: {
                // Handles:
                // !riddle <subject>
                // !riddle <rounds>
                // !riddle <subject> <rounds>
                // !riddle <multi word subject>
                // !riddle <multi word subject> <rounds>

                if (isPositiveInteger(subCommand)) {
                    // !riddle <rounds>
                    numberOfRounds = parseInt(subCommand, 10);
                    topic = null; // General or game-based
                } else {
                    // Last argument might be rounds
                    const lastArg = args[args.length - 1];
                    if (args.length > 1 && isPositiveInteger(lastArg)) {
                        numberOfRounds = parseInt(lastArg, 10);
                        topic = args.slice(0, -1).join(' ');
                    } else {
                        // All args form the topic
                        topic = args.join(' ');
                    }
                }
                
                // Clean topic (remove quotes)
                if (topic) {
                    topic = topic.replace(/^"|"$/g, '').trim();
                    if (topic.toLowerCase() === 'game') { // Explicit request for current game
                        topic = 'game'; // Special keyword for manager
                    } else if (topic.length === 0) {
                        topic = null; // Treat empty quoted topic as general
                    }
                }


                logger.info(`[RiddleCmd] Attempting to start riddle game in ${channelNameNoHash} by ${invokingDisplayName}. Topic: ${topic || 'Default'}, Rounds: ${numberOfRounds}`);
                const startResult = await riddleManager.startGame(channelNameNoHash, topic, invokingUsernameLower, numberOfRounds);
                if (!startResult.success && startResult.error) {
                    await enqueueMessage(channel, `${startResult.error}`, { replyToId });
                }
                // Success messages are handled by the game manager
                break;
            }
        }
    }
};

export default riddleHandler;