// src/components/commands/handlers/forgetme.js
import { sendLocalized } from '../../../lib/localizedMessage.js';
import { forgetUser } from '../../memory/memoryManager.js';

/**
 * Handler for the !forgetme command.
 * Any viewer can delete what the bot remembers about them in this channel and opt out of being
 * remembered from here on.
 *
 * Usage: !forgetme
 */
async function execute(context) {
    const { channel, user, logger } = context;
    const channelName = channel.substring(1); // Remove the '#' prefix
    const username = user.username;
    const replyToId = user?.id || user?.['message-id'] || null;

    try {
        const count = await forgetUser(channelName, username);
        await sendLocalized(channel, 'cmd.memory.ForgotUser', {}, `Done. I've forgotten what I knew about you here and won't remember you going forward.`, { replyToId });
        logger.info({ channel: channelName, user: username, count }, '[ForgetMeCommand] Handled !forgetme');
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: username }, `[ForgetMeCommand] Error executing forgetme command in channel ${channelName}`);
        try {
            await sendLocalized(channel, 'cmd.memory.SorrySomethingWentWrong', {}, `Sorry, something went wrong with my memory. Please try again later.`, { replyToId });
        } catch (msgError) {
            logger.warn({ err: msgError }, '[ForgetMeCommand] Failed to send error message to chat');
        }
    }
}

export default {
    execute,
    permission: 'everyone',
    description: 'Deletes what the bot remembers about you and opts you out of channel memory'
};
