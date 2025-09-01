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

    // Check if command name was provided
    if (args.length === 0) {
        enqueueMessage(channel, `Usage: !disable <commandName>. Example: !disable trivia`, { replyToId });
        return;
    }

    const commandToDisable = args[0].toLowerCase();
    
    // Validate that the command exists
    if (!isValidCommand(commandToDisable, commandHandlers)) {
        const availableCommands = getAllAvailableCommands(commandHandlers);
        enqueueMessage(channel, `Unknown command '${commandToDisable}'. Available commands: ${availableCommands.join(', ')}`, { replyToId });
        return;
    }

    logger.info(`[DisableCommand] User ${username} attempting to disable command '${commandToDisable}' in channel ${channelName}`);

    try {
        const result = await disableCommandForChannel(channelName, commandToDisable);
        
        if (result.success) {
            enqueueMessage(channel, result.message, { replyToId });
            logger.info(`[DisableCommand] Successfully disabled command '${commandToDisable}' in channel ${channelName} by ${username}`);
        } else {
            enqueueMessage(channel, result.message, { replyToId });
            logger.warn(`[DisableCommand] Failed to disable command '${commandToDisable}' in channel ${channelName}: ${result.message}`);
        }
    } catch (error) {
        logger.error({
            err: error,
            channel: channelName,
            user: username,
            command: commandToDisable
        }, `[DisableCommand] Error disabling command '${commandToDisable}' in channel ${channelName}`);
        
        enqueueMessage(channel, `Sorry, there was an error disabling the command. Please try again later.`, { replyToId });
    }
}

// Export the handler with metadata
export default {
    execute,
    permission: 'moderator', // Only moderators and broadcasters can disable commands
    description: 'Disables a command in this channel'
};