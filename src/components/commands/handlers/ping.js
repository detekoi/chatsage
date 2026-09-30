// src/components/commands/handlers/ping.js
import logger from '../../../lib/logger.js';
import { sendLocalized } from '../../../lib/localizedMessage.js';

/**
 * Handler for the !ping command.
 * Responds with "Pong!" to check bot responsiveness.
 */
const pingHandler = {
    name: 'ping',
    description: 'Checks if the bot is responsive. Responds with Pong!',
    usage: '!ping',
    permission: 'everyone', // Anyone can use this command
    execute: async (context) => {
        const { channel, user } = context;
        const replyToId = user?.id || user?.['id'] || user?.['message-id'] || null;
        const response = 'Pong!';

        logger.info({ channel, user: user.username }, `[PingCommand] PRE-ENQUEUE: Preparing ping response for ${user.username}`);

        try {
            await sendLocalized(channel, 'cmd.ping.Pong', {}, response, { replyToId });
            logger.info({ channel, user: user.username }, `[PingCommand] POST-ENQUEUE: Successfully called enqueueMessage`);

            logger.info(`Executed !ping command in ${channel} for ${user.username}`);
        } catch (error) {
            logger.error(
                { err: error, channel: channel, user: user.username },
                `[PingCommand] CRITICAL ERROR: Failed to send Pong response`
            );
            throw error;
        }
    },
};

export default pingHandler;