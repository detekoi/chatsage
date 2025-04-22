import logger from '../../../lib/logger.js';
import { enqueueMessage } from '../../../lib/ircSender.js';

const HELP_URL = 'https://detekoi.github.io/botcommands.html';

/**
 * Handler for the !help command.
 * Provides a link to the commands documentation website.
 */
const helpHandler = {
    name: 'help',
    description: 'Shows where to find the list of available commands.',
    usage: '!help or !commands',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user } = context;
        const displayName = user['display-name'] || user.username;

        try {
            const response = `@${displayName}, you can find my command list and usage examples here: ${HELP_URL}`;
            enqueueMessage(channel, response);
            logger.info(`Executed !help command in ${channel} for ${user.username}`);
        } catch (error) {
            logger.error({ err: error, channel: channel, user: user.username }, `Failed to enqueue help response.`);
        }
    },
};

export default helpHandler;