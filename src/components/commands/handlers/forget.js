// src/components/commands/handlers/forget.js
import { sendLocalized } from '../../../lib/localizedMessage.js';
import { forgetByQuery } from '../../memory/memoryManager.js';

/**
 * Handler for the !forget command.
 * Lets moderators and broadcasters delete channel memories matching a phrase.
 *
 * Usage: !forget <phrase>
 * Example: !forget gary
 */
async function execute(context) {
    const { channel, user, args, logger } = context;
    const channelName = channel.substring(1); // Remove the '#' prefix
    const username = user.username;
    const replyToId = user?.id || user?.['message-id'] || null;

    try {
        const phrase = args.join(' ').trim();
        if (phrase.length < 3) {
            await sendLocalized(channel, 'cmd.memory.UsageForget', {}, `Usage: !forget <phrase>`, { replyToId });
            return;
        }

        const count = await forgetByQuery(channelName, phrase);
        if (count > 0) {
            await sendLocalized(channel, 'cmd.memory.ForgotCount', { count, phrase }, `Forgot ${count} memories matching "${phrase}".`, { replyToId });
        } else {
            await sendLocalized(channel, 'cmd.memory.NothingToForget', { phrase }, `I don't have anything stored about "${phrase}".`, { replyToId });
        }
        logger.info({ channel: channelName, user: username, phrase, count }, '[ForgetCommand] Handled !forget');
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: username }, `[ForgetCommand] Error executing forget command in channel ${channelName}`);
        try {
            await sendLocalized(channel, 'cmd.memory.SorrySomethingWentWrong', {}, `Sorry, something went wrong with my memory. Please try again later.`, { replyToId });
        } catch (msgError) {
            logger.warn({ err: msgError }, '[ForgetCommand] Failed to send error message to chat');
        }
    }
}

export default {
    execute,
    permission: 'moderator',
    description: 'Deletes channel memories matching a phrase'
};
