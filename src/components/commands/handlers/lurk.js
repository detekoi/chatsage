// src/components/commands/handlers/lurk.js
import logger from '../../../lib/logger.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { generateStandardResponse, buildContextPrompt } from '../../llm/geminiClient.js';
import { getContextManager } from '../../context/contextManager.js';

/**
 * Handler for the !lurk command.
 * Provides a fun, contextual send-off to a user who is going to lurk.
 */
const lurkHandler = {
    name: 'lurk',
    description: 'Let the chat know you are lurking. Provide an optional reason for a custom send-off.',
    usage: '!lurk [your reason for lurking]',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, args } = context;
        const displayName = user['display-name'] || user.username;
        const lurkReason = args.join(' ').trim();
        const channelName = channel.substring(1); // Remove '#' for context manager
        const contextManager = getContextManager();

        try {
            // Get the full context object from the context manager
            const llmContext = contextManager.getContextForLLM(channelName, displayName, `is going to lurk. Reason: ${lurkReason || 'none'}`);
            if (!llmContext) {
                logger.warn(`[${channelName}] Could not get context for !lurk command.`);
                // Provide a simple fallback if context fails
                enqueueMessage(channel, `Enjoy the lurk, @${displayName}!`);
                return;
            }

            // Build the context string to pass to the LLM
            const chatContext = buildContextPrompt(llmContext);

            let prompt;

            if (lurkReason) {
                // Prompt that focuses on the user's reason for lurking
                prompt = `A Twitch user named "${displayName}" is about to start lurking. Their reason is: "${lurkReason}". Based on the recent chat conversation, generate a short, friendly, and encouraging send-off for them. Wish them well with their task and try to connect it to the ongoing chat topic. Keep it concise, positive, and under 25 words.`;
            } else {
                // Prompt for a general lurk command, using chat context
                prompt = `A Twitch user named "${displayName}" is about to start lurking. Based on the recent chat conversation, generate a short, friendly, and personalized send-off. Make the response feel like a natural continuation of the current chat. Keep it concise, positive, and under 25 words.`;
            }
            
            const llmResponse = await generateStandardResponse(chatContext, prompt);

            let response;
            if (llmResponse) {
                response = `@${displayName}, ${llmResponse}`;
            } else {
                // A simple fallback in case the LLM fails to generate a response
                response = `Enjoy the lurk, @${displayName}! We'll be here when you get back.`;
            }
            
            enqueueMessage(channel, response);
            logger.info(`Executed !lurk command in ${channel} for ${displayName}`);

        } catch (error) {
            logger.error({ err: error, channel: channel, user: user.username }, 'Error executing !lurk command');
            // Fallback in case of any error during the process
            enqueueMessage(channel, `Thanks for the lurk, @${displayName}! Enjoy!`);
        }
    },
};

export default lurkHandler;