// src/components/commands/handlers/remember.js
import { sendLocalized } from '../../../lib/localizedMessage.js';
import { isMemoryEnabled, saveMemory } from '../../memory/memoryManager.js';
import { structureManualMemory } from '../../memory/memoryExtractor.js';

/**
 * Handler for the !remember command.
 * Lets moderators and broadcasters teach the bot a piece of channel lore.
 *
 * Usage: !remember <fact>
 * Example: !remember gary = the rubber duck on the desk
 */
async function execute(context) {
    const { channel, user, args, logger } = context;
    const channelName = channel.substring(1); // Remove the '#' prefix
    const username = user.username;
    const replyToId = user?.id || user?.['message-id'] || null;

    try {
        const rawText = args.join(' ').trim();
        if (!rawText) {
            await sendLocalized(channel, 'cmd.memory.UsageRemember', {}, `Usage: !remember <fact>. Example: !remember gary = the rubber duck on the desk`, { replyToId });
            return;
        }

        if (!(await isMemoryEnabled(channelName))) {
            await sendLocalized(channel, 'cmd.memory.MemoryIsOff', {}, `Memory is off in this channel. A mod can turn it on with !memory on.`, { replyToId });
            return;
        }

        const structured = await structureManualMemory(rawText);
        const result = await saveMemory(channelName, { ...structured, source: 'manual', addedBy: username });

        if (result.action === 'added') {
            await sendLocalized(channel, 'cmd.memory.Remembered', {}, `Got it, I'll remember that.`, { replyToId });
        } else if (result.action === 'updated') {
            await sendLocalized(channel, 'cmd.memory.UpdatedMemory', {}, `Got it, I updated what I knew about that.`, { replyToId });
        } else if (result.reason === 'full') {
            await sendLocalized(channel, 'cmd.memory.MemoryFull', {}, `My memory for this channel is full. Use !forget <phrase> to make room.`, { replyToId });
        } else {
            await sendLocalized(channel, 'cmd.memory.CouldNotRemember', {}, `I couldn't work out what to file that under. Try: !remember <phrase> = <what it means>`, { replyToId });
        }
        logger.info({ channel: channelName, user: username, action: result.action, reason: result.reason }, '[RememberCommand] Handled !remember');
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: username }, `[RememberCommand] Error executing remember command in channel ${channelName}`);
        try {
            await sendLocalized(channel, 'cmd.memory.SorrySomethingWentWrong', {}, `Sorry, something went wrong with my memory. Please try again later.`, { replyToId });
        } catch (msgError) {
            logger.warn({ err: msgError }, '[RememberCommand] Failed to send error message to chat');
        }
    }
}

export default {
    execute,
    permission: 'moderator',
    description: 'Teaches the bot a piece of channel lore to remember long-term'
};
