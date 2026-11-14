// src/components/commands/handlers/deslop.js
import { sendLocalized } from '../../../lib/localizedMessage.js';
import { isDeslopEnabled, setDeslopEnabled } from '../../context/responseStyleStorage.js';
import { resetChatSession } from '../../llm/llmClient.js';

/**
 * Handler for the !deslop command.
 * De-Slop adds plain-writing rules to the channel's prompts (see src/lib/deslop.js).
 * It is off by default; the dashboard has the same switch.
 *
 * Usage: !deslop | !deslop on | !deslop off
 */
async function execute(context) {
    const { channel, user, args, logger } = context;
    const channelName = channel.substring(1); // Remove the '#' prefix
    const username = user.username;
    const replyToId = user?.id || user?.['message-id'] || null;

    try {
        const action = (args[0] || '').toLowerCase();

        if (action === 'on' || action === 'off') {
            const enabled = action === 'on';
            if (enabled !== isDeslopEnabled(channelName)) {
                await setDeslopEnabled(channelName, enabled);
                // The chat session bakes the system instruction in at construction.
                resetChatSession(channelName);
            }
            if (enabled) {
                await sendLocalized(channel, 'cmd.deslop.TurnedOn', {}, `De-Slop is on. I'll cut the AI-sounding filler from what I write. Turn it off with !deslop off.`, { replyToId });
            } else {
                await sendLocalized(channel, 'cmd.deslop.TurnedOff', {}, `De-Slop is off. Turn it back on with !deslop on.`, { replyToId });
            }
            logger.info({ channel: channelName, user: username, enabled }, '[DeslopCommand] De-Slop setting changed');
            return;
        }

        if (isDeslopEnabled(channelName)) {
            await sendLocalized(channel, 'cmd.deslop.StatusOn', {}, `De-Slop is on. Mods can turn it off with !deslop off.`, { replyToId });
        } else {
            await sendLocalized(channel, 'cmd.deslop.StatusOff', {}, `De-Slop is off. Mods can turn it on with !deslop on.`, { replyToId });
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: username }, `[DeslopCommand] Error executing deslop command in channel ${channelName}`);
        try {
            await sendLocalized(channel, 'cmd.deslop.SorrySomethingWentWrong', {}, `Sorry, I couldn't change that setting. Please try again later.`, { replyToId });
        } catch (msgError) {
            logger.warn({ err: msgError }, '[DeslopCommand] Failed to send error message to chat');
        }
    }
}

export default {
    execute,
    permission: 'moderator',
    description: 'Shows or changes whether the bot follows the De-Slop plain-writing rules in this channel',
    usage: '!deslop [on|off]'
};
