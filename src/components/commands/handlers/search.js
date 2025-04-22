import logger from '../../../lib/logger.js';
// Import BOTH search generation AND the new summarizer
import { generateSearchGroundedResponse, summarizeText } from '../../llm/geminiClient.js';

// Define IRC message length limit (be conservative)
const MAX_IRC_MESSAGE_LENGTH = 450;
// Target length for summaries (should be less than MAX_IRC_MESSAGE_LENGTH)
const SUMMARY_TARGET_LENGTH = 400;

/**
 * Handler for the !search command.
 * Takes user query, asks Gemini to search Google, and returns the result.
 */
const searchHandler = {
    name: 'search',
    description: 'Searches the web for information on a topic. Usage: !search <your query>',
    permission: 'everyone', // Or restrict if desired (e.g., 'subscriber')
    execute: async (context) => {
        const { channel, user, args, ircClient } = context;
        const userQuery = args.join(' ').trim();
        const userName = user['display-name'] || user.username; // Get username for replies

        if (!userQuery) {
            try {
                await ircClient.say(channel, `@${userName}, please provide something to search for. Usage: !search <your query>`);
            } catch (sayError) { logger.error({ err: sayError }, 'Failed to send search usage message.'); }
            return;
        }

        logger.info(`Executing !search command for ${userName} in ${channel} with query: "${userQuery}"`);

        const searchPrompt = `Please perform a Google Search for the following topic and provide a concise answer based only on the search results: "${userQuery}"`;

        try {
            // 1. Get initial search response
            const initialResponseText = await generateSearchGroundedResponse(searchPrompt);

            if (!initialResponseText || initialResponseText.trim().length === 0) {
                logger.warn(`LLM returned no result for search query: "${userQuery}"`);
                await ircClient.say(channel, `@${userName}, sorry, I couldn't find information about "${userQuery}" right now.`);
                return; // Exit if no initial response
            }

            // 2. Format the initial reply and check length
            let replyPrefix = `@${userName} Here's what I found about "${userQuery}": `;
            let finalReplyText = initialResponseText; // Start with the full response

            if ((replyPrefix.length + finalReplyText.length) > MAX_IRC_MESSAGE_LENGTH) {
                logger.info(`Initial search response too long (${finalReplyText.length} chars). Attempting summarization.`);
                replyPrefix = `@${userName} The info was a bit long, here's a summary about "${userQuery}": `;

                // 3. Summarize if too long
                const summary = await summarizeText(initialResponseText, SUMMARY_TARGET_LENGTH);

                if (summary && summary.trim().length > 0) {
                    finalReplyText = summary; // Use the summary
                    logger.info(`Summarization successful (${finalReplyText.length} chars).`);
                } else {
                    logger.warn(`Summarization failed or returned empty for query: "${userQuery}". Falling back to truncation.`);
                    // Fallback: Truncate the original response if summarization fails
                    const availableLength = MAX_IRC_MESSAGE_LENGTH - replyPrefix.length - 3; // -3 for "..."
                    finalReplyText = initialResponseText.substring(0, availableLength < 0 ? 0 : availableLength) + '...';
                }
            }

            // 4. Final length check (even summary might be too long in rare cases) & Send
            let finalMessage = replyPrefix + finalReplyText;
            if (finalMessage.length > MAX_IRC_MESSAGE_LENGTH) {
                 logger.warn(`Final reply (even after summary/truncation) too long (${finalMessage.length} chars). Truncating sharply.`);
                 finalMessage = finalMessage.substring(0, MAX_IRC_MESSAGE_LENGTH - 3) + '...';
            }

            await ircClient.say(channel, finalMessage);

        } catch (error) {
            logger.error({ err: error, command: 'search', query: userQuery }, `Error executing !search command.`);
            try {
                await ircClient.say(channel, `@${userName}, sorry, an error occurred while searching.`);
            } catch (sayError) { logger.error({ err: sayError }, 'Failed to send search error message.'); }
        }
    },
};

export default searchHandler;