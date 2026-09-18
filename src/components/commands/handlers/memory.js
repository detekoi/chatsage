// src/components/commands/handlers/memory.js
import { sendLocalized } from '../../../lib/localizedMessage.js';
import { getMemoryStatus, setMemoryEnabled } from '../../memory/memoryManager.js';

/**
 * Handler for the !memory command.
 * Long-term channel memory is on by default; this is how a channel opts out (or back in).
 *
 * Usage: !memory | !memory on | !memory off
 */
async function execute(context) {
    const { channel, user, args, logger } = context;
    const channelName = channel.substring(1); // Remove the '#' prefix
    const username = user.username;
    const replyToId = user?.id || user?.['message-id'] || null;

    try {
        const action = (args[0] || '').toLowerCase();

        if (action === 'on' || action === 'off') {
            await setMemoryEnabled(channelName, action === 'on');
            if (action === 'on') {
                await sendLocalized(channel, 'cmd.memory.TurnedOn', {}, `Memory is on. I'll remember this channel's lore and in-jokes. Turn it off with !memory off.`, { replyToId });
            } else {
                await sendLocalized(channel, 'cmd.memory.TurnedOff', {}, `Memory is off. I won't capture or use channel memories. Turn it back on with !memory on.`, { replyToId });
            }
            logger.info({ channel: channelName, user: username, enabled: action === 'on' }, '[MemoryCommand] Channel memory setting changed');
            return;
        }

        const { enabled, count } = await getMemoryStatus(channelName);
        if (enabled) {
            await sendLocalized(channel, 'cmd.memory.StatusOn', { count }, `Memory is on with ${count} memories stored. Mods: !memory off | !remember <fact> | !forget <phrase>. Anyone: !forgetme`, { replyToId });
        } else {
            await sendLocalized(channel, 'cmd.memory.StatusOff', { count }, `Memory is off with ${count} memories stored. Mods can turn it on with !memory on.`, { replyToId });
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: username }, `[MemoryCommand] Error executing memory command in channel ${channelName}`);
        try {
            await sendLocalized(channel, 'cmd.memory.SorrySomethingWentWrong', {}, `Sorry, something went wrong with my memory. Please try again later.`, { replyToId });
        } catch (msgError) {
            logger.warn({ err: msgError }, '[MemoryCommand] Failed to send error message to chat');
        }
    }
}

export default {
    execute,
    permission: 'moderator',
    description: 'Shows or changes whether the bot keeps long-term memory for this channel'
};
