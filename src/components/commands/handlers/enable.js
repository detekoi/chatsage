// src/components/commands/handlers/enable.js
import { enableCommandForChannel, isValidCommand, getAllAvailableCommands } from '../../context/commandStateManager.js';
import commandHandlers from './index.js';

/**
 * Handler for the !enable command.
 * Allows moderators and broadcasters to enable a previously disabled command in their channel.
 * 
 * Usage: !enable <commandName>
 * Example: !enable trivia
 */
async function execute(context) {
    const { channel, user, args, ircClient, logger } = context;
    const channelName = channel.substring(1); // Remove the '#' prefix
    const username = user.username;
    const displayName = user['display-name'] || username;

    // Check if command name was provided
    if (args.length === 0) {
        await ircClient.say(channel, `@${displayName}, Usage: !enable <commandName>. Example: !enable trivia`);
        return;
    }

    const commandToEnable = args[0].toLowerCase();
    
    // Validate that the command exists
    if (!isValidCommand(commandToEnable, commandHandlers)) {
        const availableCommands = getAllAvailableCommands(commandHandlers);
        await ircClient.say(channel, `@${displayName}, Unknown command '${commandToEnable}'. Available commands: ${availableCommands.join(', ')}`);
        return;
    }

    logger.info(`[EnableCommand] User ${username} attempting to enable command '${commandToEnable}' in channel ${channelName}`);

    try {
        const result = await enableCommandForChannel(channelName, commandToEnable);
        
        if (result.success) {
            await ircClient.say(channel, `@${displayName}, ${result.message}`);
            logger.info(`[EnableCommand] Successfully enabled command '${commandToEnable}' in channel ${channelName} by ${username}`);
        } else {
            await ircClient.say(channel, `@${displayName}, ${result.message}`);
            logger.warn(`[EnableCommand] Failed to enable command '${commandToEnable}' in channel ${channelName}: ${result.message}`);
        }
    } catch (error) {
        logger.error({
            err: error,
            channel: channelName,
            user: username,
            command: commandToEnable
        }, `[EnableCommand] Error enabling command '${commandToEnable}' in channel ${channelName}`);
        
        await ircClient.say(channel, `@${displayName}, Sorry, there was an error enabling the command. Please try again later.`);
    }
}

// Export the handler with metadata
export default {
    execute,
    permission: 'moderator', // Only moderators and broadcasters can enable commands
    description: 'Enables a previously disabled command in this channel'
};