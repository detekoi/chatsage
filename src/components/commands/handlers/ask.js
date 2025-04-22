import logger from '../../../lib/logger.js';
import { getContextManager } from '../../context/contextManager.js';
// Import the relevant functions from geminiClient
import {
    buildContextPrompt,
    decideSearchWithFunctionCalling,
    generateStandardResponse,
    generateSearchResponse,
    summarizeText
} from '../../llm/geminiClient.js';
// Import the sender queue
import { enqueueMessage } from '../../../lib/ircSender.js';

// Define IRC message length limit (be conservative)
const MAX_IRC_MESSAGE_LENGTH = 450;
// Target length for summaries (should be less than MAX_IRC_MESSAGE_LENGTH)
const SUMMARY_TARGET_LENGTH = 400;

/**
 * Handles formatting, length checking, summarization, and sending the response.
 * @param {string} channel - Channel to send to (# included).
 * @param {string} userName - User to respond to.
 * @param {string | null} responseText - The LLM response text.
 * @param {string} userQuery - The original query for context.
 */
async function handleAskResponseFormatting(channel, userName, responseText, userQuery) {
    if (!responseText?.trim()) {
        logger.warn(`LLM returned no answer for !ask query "${userQuery}" from ${userName}`);
        enqueueMessage(channel, `@${userName}, sorry, I couldn't find or generate an answer for that right now.`);
        return;
    }

    let replyPrefix = `@${userName} `;
    let finalReplyText = responseText;

    if ((replyPrefix.length + finalReplyText.length) > MAX_IRC_MESSAGE_LENGTH) {
        logger.info(`Initial !ask response too long (${finalReplyText.length} chars). Attempting summarization.`);
        replyPrefix = `@${userName}: `; // Changed to a more concise prefix that does not include "(Summary)"

        const summary = await summarizeText(finalReplyText, SUMMARY_TARGET_LENGTH);
        if (summary?.trim()) {
            finalReplyText = summary;
            logger.info(`Summarization successful (${finalReplyText.length} chars).`);
        } else {
            logger.warn(`Summarization failed for !ask response. Falling back to truncation.`);
            const availableLength = MAX_IRC_MESSAGE_LENGTH - replyPrefix.length - 3;
            finalReplyText = responseText.substring(0, availableLength < 0 ? 0 : availableLength) + '...';
        }
    }

    let finalMessage = replyPrefix + finalReplyText;
    if (finalMessage.length > MAX_IRC_MESSAGE_LENGTH) {
        logger.warn(`Final !ask reply too long (${finalMessage.length} chars). Truncating sharply.`);
        finalMessage = finalMessage.substring(0, MAX_IRC_MESSAGE_LENGTH - 3) + '...';
    }

    enqueueMessage(channel, finalMessage);
}

/**
 * Handler for the !ask command using function calling to decide on search.
 */
const askHandler = {
    name: 'ask', // Keep name as 'ask'
    description: 'Ask ChatSage a question. Uses search intelligently.',
    usage: '!ask <your question>',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, args } = context; // No ircClient needed directly
        const userQuery = args.join(' ').trim();
        const channelName = channel.substring(1);
        const userName = user['display-name'] || user.username;
        const contextManager = getContextManager();

        if (!userQuery) {
            enqueueMessage(channel, `@${userName}, please ask a question after the command. Usage: !ask <your question>`);
            return;
        }

        logger.info(`Executing !ask command for ${userName} in ${channel} with query: "${userQuery}"`);

        try {
            // 1. Get Context (only needed for context prompt part)
            const llmContext = contextManager.getContextForLLM(channelName, userName, `asked: ${userQuery}`);
            if (!llmContext) {
                logger.warn(`[${channelName}] Could not get context for !ask command.`);
                enqueueMessage(channel, `@${userName}, sorry, I couldn't retrieve the current context.`);
                return;
            }
            const contextPrompt = buildContextPrompt(llmContext); // Build context string

            // 2. Use Function Calling to Decide Search Need
            const decisionResult = await decideSearchWithFunctionCalling(contextPrompt, userQuery);
            logger.info({ decisionResult }, `Search decision made for query: "${userQuery}"`);

            // 3. Generate Response based on Decision
            let responseText = null;
            if (decisionResult.searchNeeded) {
                 logger.info(`Proceeding with search-grounded response for query: "${userQuery}"`);
                 // Call the generator that uses the googleSearchRetrieval tool
                 responseText = await generateSearchResponse(contextPrompt, userQuery);
            } else {
                 logger.info(`Proceeding with standard (no search) response for query: "${userQuery}"`);
                 // Call the generator that ONLY uses internal knowledge
                 responseText = await generateStandardResponse(contextPrompt, userQuery);
            }

            // 4. Format and Send the Response
            await handleAskResponseFormatting(channel, userName, responseText, userQuery);

        } catch (error) {
            logger.error({ err: error, command: 'ask', query: userQuery }, `Error executing !ask command.`);
            enqueueMessage(channel, `@${userName}, sorry, an error occurred while processing your question.`);
        }
    },
};

export default askHandler; // Still export as askHandler