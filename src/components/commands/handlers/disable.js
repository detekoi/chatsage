// src/components/commands/handlers/disable.js
import { disableCommandForChannel, isValidCommand, getAllAvailableCommands } from '../../context/commandStateManager.js';
import commandHandlers from './index.js';
import { enqueueMessage } from '../../../lib/ircSender.js';

/**
 * Handler for the !disable command.
 * Allows moderators and broadcasters to disable a command in their channel.
 * 
 * Usage: !disable <commandName>
 * Example: !disable trivia
 */
async function execute(context) {
    const { channel, user, args, logger } = context;
    const channelName = channel.substring(1); // Remove the '#' prefix
    const username = user.username;
    const replyToId = user?.id || user?.['message-id'] || null;

    try {
        // Check if command name was provided
        if (args.length === 0) {
            await enqueueMessage(channel, `Usage: !disable <commandName>. Example: !disable trivia`, { replyToId });
            return;
        }

        const commandToDisable = args[0].toLowerCase();
        
        // Validate that the command exists
        if (!isValidCommand(commandToDisable, commandHandlers)) {
            const availableCommands = getAllAvailableCommands(commandHandlers);
            await enqueueMessage(channel, `Unknown command '${commandToDisable}'. Available commands: ${availableCommands.join(', ')}`, { replyToId });
            return;
        }

        logger.info(`[DisableCommand] User ${username} attempting to disable command '${commandToDisable}' in channel ${channelName}`);

        const result = await disableCommandForChannel(channelName, commandToDisable);
        
        if (result.success) {
            await enqueueMessage(channel, result.message, { replyToId });
            logger.info(`[DisableCommand] Successfully disabled command '${commandToDisable}' in channel ${channelName} by ${username}`);
        } else {
            await enqueueMessage(channel, result.message, { replyToId });
            logger.warn(`[DisableCommand] Failed to disable command '${commandToDisable}' in channel ${channelName}: ${result.message}`);
        }
    } catch (error) {
        logger.error({
            err: error,
            channel: channelName,
            user: username,
            command: args[0] || 'N/A'
        }, `[DisableCommand] Error executing disable command in channel ${channelName}`);
        
        try {
            await enqueueMessage(channel, `Sorry, there was an error disabling the command. Please try again later.`, { replyToId });
        } catch (msgError) {
            logger.warn({ err: msgError }, '[DisableCommand] Failed to send error message to chat');
        }
    }
}

// Export the handler with metadata
export default {
    execute,
    permission: 'moderator', // Only moderators and broadcasters can disable commands
    description: 'Disables a command in this channel'
};