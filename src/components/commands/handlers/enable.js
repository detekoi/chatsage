// src/components/commands/handlers/enable.js
import { enableCommandForChannel, isValidCommand, getAllAvailableCommands } from '../../context/commandStateManager.js';
import commandHandlers from './index.js';
import { sendLocalized, sendLocalizedResult } from '../../../lib/localizedMessage.js';

/**
 * Handler for the !enable command.
 * Allows moderators and broadcasters to enable a previously disabled command in their channel.
 * 
 * Usage: !enable <commandName>
 * Example: !enable trivia
 */
async function execute(context) {
    const { channel, user, args, logger } = context;
    const channelName = channel.substring(1); // Remove the '#' prefix
    const username = user.username;
    const replyToId = user?.id || user?.['message-id'] || null;

    try {
        // Check if command name was provided
        if (args.length === 0) {
            await sendLocalized(channel, 'cmd.enable.UsageEnableCommandnameExample', {}, `Usage: !enable <commandName>. Example: !enable trivia`, { replyToId });
            return;
        }

        const commandToEnable = args[0].toLowerCase();

        // Validate that the command exists
        if (!isValidCommand(commandToEnable, commandHandlers)) {
            const availableCommands = getAllAvailableCommands(commandHandlers);
            await sendLocalized(channel, 'cmd.enable.UnknownCommandAvailableCommands', { commandToEnable, p2: availableCommands.join(', ') }, `Unknown command '${commandToEnable}'. Available commands: ${availableCommands.join(', ')}`, { replyToId });
            return;
        }

        logger.info(`[EnableCommand] User ${username} attempting to enable command '${commandToEnable}' in channel ${channelName}`);

        const result = await enableCommandForChannel(channelName, commandToEnable);

        if (result.success) {
            await sendLocalizedResult(channel, result, { replyToId });
            logger.info(`[EnableCommand] Successfully enabled command '${commandToEnable}' in channel ${channelName} by ${username}`);
        } else {
            await sendLocalizedResult(channel, result, { replyToId });
            logger.warn(`[EnableCommand] Failed to enable command '${commandToEnable}' in channel ${channelName}: ${result.message}`);
        }
    } catch (error) {
        logger.error({
            err: error,
            channel: channelName,
            user: username,
            command: args[0] || 'N/A'
        }, `[EnableCommand] Error executing enable command in channel ${channelName}`);

        try {
            await sendLocalized(channel, 'cmd.enable.SorryThereWasError', {}, `Sorry, there was an error enabling the command. Please try again later.`, { replyToId });
        } catch (msgError) {
            logger.warn({ err: msgError }, '[EnableCommand] Failed to send error message to chat');
        }
    }
}

// Export the handler with metadata
export default {
    execute,
    permission: 'moderator', // Only moderators and broadcasters can enable commands
    description: 'Enables a previously disabled command in this channel'
};