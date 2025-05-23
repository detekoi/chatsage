import logger from '../../../lib/logger.js';
// Import context manager and prompt builder
import { getContextManager } from '../../context/contextManager.js';
import { buildContextPrompt, generateSearchResponse, summarizeText } from '../../llm/geminiClient.js';
import { enqueueMessage } from '../../../lib/ircSender.js';

// Define IRC message length limit (be conservative)
const MAX_IRC_MESSAGE_LENGTH = 450;
// Target length for summaries (should be less than MAX_IRC_MESSAGE_LENGTH)
const SUMMARY_TARGET_LENGTH = 400;

/**
 * Handler for the !search command.
 * Fetches context, then asks Gemini to search Google and returns the result.
 */
const searchHandler = {
    name: 'search',
    description: 'Searches the web for information on a topic.',
    usage: '!search <your query>',
    permission: 'everyone', // Or restrict if desired (e.g., 'subscriber')
    execute: async (context) => {
        const { channel, user, args } = context;
        const userQuery = args.join(' ').trim();
        const channelName = channel.substring(1); // Remove #
        const userName = user['display-name'] || user.username; // Get username for replies
        const contextManager = getContextManager(); // Get context manager

        if (!userQuery) {
            enqueueMessage(channel, `@${userName}, please provide something to search for. Usage: !search <your query>`);
            return;
        }

        logger.info(`Executing !search command for ${userName} in ${channel} with query: "${userQuery}"`);

        try {
            // 1. Get Context
            const llmContext = contextManager.getContextForLLM(channelName, userName, `searching for: ${userQuery}`); // Get context object
            if (!llmContext) {
                logger.warn(`[${channelName}] Could not get context for !search command from user ${userName}.`);
                enqueueMessage(channel, `@${userName}, sorry, I couldn't retrieve the current context to perform the search.`);
                return;
            }
            const contextPrompt = buildContextPrompt(llmContext); // Build context string

            // 2. Get search response using the correct function and arguments
            const initialResponseText = await generateSearchResponse(contextPrompt, userQuery); // Pass BOTH context and query

            if (!initialResponseText || initialResponseText.trim().length === 0) {
                logger.warn(`LLM returned no result for search query: "${userQuery}"`);
                enqueueMessage(channel, `@${userName}, sorry, I couldn't find information about "${userQuery}" right now.`);
                return; // Exit if no initial response
            }

            // 3. Format the initial reply and check length (prefix simplified)
            let replyPrefix = `@${userName} `; // Simpler prefix for search results
            let finalReplyText = initialResponseText;

            if ((replyPrefix.length + finalReplyText.length) > MAX_IRC_MESSAGE_LENGTH) {
                logger.info(`Initial search response too long (${finalReplyText.length} chars). Attempting summarization.`);
                replyPrefix = `@${userName}: `; // Changed to a more concise prefix that does not include "(Summary)"

                const summary = await summarizeText(finalReplyText, SUMMARY_TARGET_LENGTH);

                if (summary && summary.trim().length > 0) {
                    finalReplyText = summary;
                    logger.info(`Summarization successful (${finalReplyText.length} chars).`);
                } else {
                    logger.warn(`Summarization failed for query: "${userQuery}". Falling back to truncation.`);
                    const availableLength = MAX_IRC_MESSAGE_LENGTH - replyPrefix.length - 3;
                    finalReplyText = initialResponseText.substring(0, availableLength < 0 ? 0 : availableLength) + '...';
                }
            }

            // 4. Final length check & Send
            let finalMessage = replyPrefix + finalReplyText;
            if (finalMessage.length > MAX_IRC_MESSAGE_LENGTH) {
                logger.warn(`Final reply (even after summary/truncation) too long (${finalMessage.length} chars). Truncating sharply.`);
                finalMessage = finalMessage.substring(0, MAX_IRC_MESSAGE_LENGTH - 3) + '...';
            }
            enqueueMessage(channel, finalMessage);

        } catch (error) {
            logger.error({ err: error, command: 'search', query: userQuery }, `Error executing !search command.`);
            enqueueMessage(channel, `@${userName}, sorry, an error occurred while searching.`);
        }
    },
};

export default searchHandler;