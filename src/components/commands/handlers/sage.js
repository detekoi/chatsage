import logger from '../../../lib/logger.js';
// Import the REUSABLE LLM handler function from llmUtils
import { handleStandardLlmQuery } from '../../llm/llmUtils.js';

/**
 * Handler for the !sage command.
 * Sends the arguments to the standard LLM for a response.
 */
const sageHandler = {
    name: 'sage',
    description: 'Ask the bot a question or give it a prompt for a standard response. Usage: !sage <your prompt>',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, args, ircClient } = context;
        const userPrompt = args.join(' ').trim();
        const cleanChannel = channel.substring(1);
        const lowerUsername = user.username;
        const displayName = user['display-name'] || user.username;

        if (!userPrompt) {
            try {
                await ircClient.say(channel, `@${displayName}, please provide a prompt or question after !sage.`);
            } catch (sayError) { logger.error({ err: sayError }, 'Failed to send sage usage message.'); }
            return;
        }

        // Call the shared standard LLM query handler function
        // Pass the user's prompt as the message content
        await handleStandardLlmQuery(channel, cleanChannel, displayName, lowerUsername, userPrompt, "command:sage");
    },
};

export default sageHandler;