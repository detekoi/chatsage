// src/components/commands/handlers/ping.js
import logger from '../../../lib/logger.js';

/**
 * Handler for the !ping command.
 * Responds with "Pong!" to check bot responsiveness.
 */
const pingHandler = {
    name: 'ping',
    description: 'Checks if the bot is responsive. Responds with Pong!',
    permission: 'everyone', // Anyone can use this command
    execute: async (context) => {
        const { channel, ircClient, user } = context;
        try {
            const response = `Pong! @${user['display-name'] || user.username}`;
            await ircClient.say(channel, response);
            logger.info(`Executed !ping command in ${channel} for ${user.username}`);
        } catch (error) {
            logger.error({ err: error, channel: channel, user: user.username }, `Failed to send Pong response for !ping command.`);
            // Don't try to send another message if the first one failed
        }
    },
};

export default pingHandler;