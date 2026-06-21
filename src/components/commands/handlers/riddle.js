// src/components/commands/handlers/riddle.js
import logger from '../../../lib/logger.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { getRiddleGameManager } from '../../riddle/riddleGameManager.js';
import { getLeaderboard } from '../../riddle/riddleStorage.js';
import { formatRiddleHelpMessage, formatRiddleLeaderboardMessage } from '../../riddle/riddleMessageFormatter.js';
import config from '../../../config/index.js';
import {
    extractGameContext,
    handleLeaderboard,
    handleClearLeaderboard,
    handleReport,
    validateRounds,
    startGameWithErrorHandling,
    isPositiveInteger,
} from './gameHandlerUtils.js';

const GAME_NAME = 'Riddle';
const COMMAND_NAME = 'riddle';

const riddleHandler = {
    name: 'riddle',
    description: 'Starts or manages a Riddle game. Use !riddle help for more info.',
    usage: '!riddle [<subject>] [<rounds>] | stop | leaderboard | clearleaderboard | report <reason...> | help',
    permission: 'everyone', // Subcommand permissions are handled internally
    execute: async (context) => {
        const gameCtx = extractGameContext(context);
        const { channel, channelName, username, displayName, replyToId, isMod, args } = gameCtx;
        const riddleManager = getRiddleGameManager();

        if (args.length === 0) {
            // !riddle - Start a game, topic will be determined by manager
            logger.info(`[RiddleCmd] Attempting to start default riddle game in ${channelName} by ${displayName}`);
            await startGameWithErrorHandling(gameCtx,
                () => riddleManager.startGame(channelName, null, username, 1),
                GAME_NAME
            );
            return;
        }

        const subCommand = args[0].toLowerCase();

        switch (subCommand) {
            case 'stop': {
                // Riddle stop has a unique pattern: it sends the result message directly
                // and has a bot self-stop guard
                if (!isMod && username !== riddleManager.getCurrentGameInitiator(channelName)) {
                    await enqueueMessage(channel, `Only the game initiator, mods, or the broadcaster can stop the riddle game.`, { replyToId });
                    return;
                }
                if (args[1] && args[1].toLowerCase() === config.twitch.username.toLowerCase()) {
                    await enqueueMessage(channel, `I can't stop myself!`, { replyToId });
                    return;
                }

                const stopResult = riddleManager.stopGame(channelName);
                await enqueueMessage(channel, `${stopResult.message}`, { replyToId });
                logger.info(`[RiddleCmd] Riddle game stop requested by ${displayName} in ${channelName}. Result: ${stopResult.message}`);
                break;
            }

            case 'leaderboard':
                await handleLeaderboard(gameCtx, getLeaderboard, formatRiddleLeaderboardMessage, GAME_NAME);
                break;

            case 'clearleaderboard':
            case 'cleardata':
                await handleClearLeaderboard(gameCtx, riddleManager, GAME_NAME);
                break;

            case 'report':
            case 'flag':
                await handleReport(gameCtx, riddleManager, GAME_NAME, COMMAND_NAME);
                break;

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
                let topic;
                let numberOfRounds = 1;

                if (isPositiveInteger(subCommand)) {
                    numberOfRounds = parseInt(subCommand, 10);
                    topic = null;
                } else {
                    const lastArg = args[args.length - 1];
                    if (args.length > 1 && isPositiveInteger(lastArg)) {
                        numberOfRounds = parseInt(lastArg, 10);
                        topic = args.slice(0, -1).join(' ');
                    } else {
                        topic = args.join(' ');
                    }
                }

                // Clean topic (remove quotes)
                if (topic) {
                    topic = topic.replace(/^"|"$/g, '').trim();
                    if (topic.toLowerCase() === 'game') {
                        topic = 'game'; // Special keyword for manager
                    } else if (topic.length === 0) {
                        topic = null;
                    }
                }

                numberOfRounds = await validateRounds(gameCtx, numberOfRounds, 10);

                logger.info(`[RiddleCmd] Attempting to start riddle game in ${channelName} by ${displayName}. Topic: ${topic || 'Default'}, Rounds: ${numberOfRounds}`);
                await startGameWithErrorHandling(gameCtx,
                    () => riddleManager.startGame(channelName, topic, username, numberOfRounds),
                    GAME_NAME
                );
                break;
            }
        }
    }
};

export default riddleHandler;