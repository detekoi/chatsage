import logger from '../../../lib/logger.js';
// Import the new search-specific function from geminiClient
import { generateSearchGroundedResponse } from '../../llm/geminiClient.js';

/**
 * Handler for the !search command.
 * Takes user query, asks Gemini to search Google, and returns the result.
 */
const searchHandler = {
    name: 'search',
    description: 'Searches the web for information on a topic using Google Search. Usage: !search <your query>',
    permission: 'everyone', // Or restrict if desired (e.g., 'subscriber')
    execute: async (context) => {
        const { channel, user, args, ircClient } = context;
        const userQuery = args.join(' ').trim();

        if (!userQuery) {
            try {
                await ircClient.say(channel, `@${user['display-name'] || user.username}, please provide something to search for. Usage: !search <your query>`);
            } catch (sayError) { logger.error({ err: sayError }, 'Failed to send search usage message.'); }
            return;
        }

        logger.info(`Executing !search command for ${user.username} in ${channel} with query: "${userQuery}"`);

        // Construct the prompt for the search-enabled Gemini call
        // Keep it simple: Instruct the model to search and answer based on results.
        const searchPrompt = `Please perform a Google Search for the following topic and provide a concise answer based only on the search results: "${userQuery}"`;

        try {
            // Call the search-specific function
            const responseText = await generateSearchGroundedResponse(searchPrompt);

            if (responseText && responseText.trim().length > 0) {
                // Simple response format
                const reply = `@${user['display-name'] || user.username} Here's what I found about "${userQuery}": ${responseText}`;
                // Consider max message length for Twitch IRC (around 450-500 chars)
                if (reply.length > 450) {
                     logger.warn(`Search response too long for IRC (${reply.length} chars). Truncating.`);
                     // Simple truncation - better would be splitting messages or summarizing further
                    await ircClient.say(channel, reply.substring(0, 447) + '...');
                } else {
                    await ircClient.say(channel, reply);
                }

            } else {
                logger.warn(`LLM returned no result for search query: "${userQuery}"`);
                await ircClient.say(channel, `@${user['display-name'] || user.username}, sorry, I couldn't find information about "${userQuery}" right now.`);
            }
        } catch (error) {
            logger.error({ err: error, command: 'search', query: userQuery }, `Error executing !search command.`);
            try {
                await ircClient.say(channel, `@${user['display-name'] || user.username}, sorry, an error occurred while searching.`);
            } catch (sayError) { logger.error({ err: sayError }, 'Failed to send search error message.'); }
        }
    },
};

export default searchHandler;