import logger from '../../lib/logger.js';
import { getContextManager } from '../context/contextManager.js';
import { getIrcClient } from '../twitch/ircClient.js';
import { generateStandardResponse as generateLlmResponse, summarizeText } from './geminiClient.js';

const MAX_IRC_MESSAGE_LENGTH = 450;
const SUMMARY_TARGET_LENGTH = 400;

/**
 * Handles getting context, calling the standard LLM, summarizing/truncating, and replying.
 * @param {string} channel - Channel name with '#'.
 * @param {string} cleanChannel - Channel name without '#'.
 * @param {string} displayName - User's display name.
 * @param {string} lowerUsername - User's lowercase username.
 * @param {string} userMessage - The user's message/prompt for the LLM.
 * @param {string} triggerType - For logging ("mention" or "command").
 */
export async function handleStandardLlmQuery(channel, cleanChannel, displayName, lowerUsername, userMessage, triggerType = "mention") {
    logger.info({ channel: cleanChannel, user: lowerUsername, trigger: triggerType }, `Handling standard LLM query.`);
    try {
        const contextManager = getContextManager();
        const ircClient = getIrcClient();

        // a. Get context
        const llmContext = contextManager.getContextForLLM(cleanChannel, displayName, userMessage);
        if (!llmContext) {
            logger.warn({ channel: cleanChannel, user: lowerUsername }, 'Could not retrieve context for LLM response.');
            // Maybe send an error message? For now, just return.
            return;
        }

        // b. Generate initial response
        const initialResponseText = await generateLlmResponse(llmContext);
        if (!initialResponseText?.trim()) {
            logger.warn({ channel: cleanChannel, user: lowerUsername, trigger: triggerType }, 'LLM generated null or empty response.');
            await ircClient.say(channel, `@${displayName} Sorry, I couldn't come up with a reply to that.`);
            return;
        }

        // c. Check length and Summarize if needed
        let replyPrefix = `@${displayName} `; // Simple prefix
        let finalReplyText = initialResponseText;

        if ((replyPrefix.length + finalReplyText.length) > MAX_IRC_MESSAGE_LENGTH) {
            logger.info(`Initial LLM response too long (${finalReplyText.length} chars). Attempting summarization.`);
            replyPrefix = `@${displayName} (Summary): `; // Indicate summary

            const summary = await summarizeText(initialResponseText, SUMMARY_TARGET_LENGTH);
            if (summary?.trim()) {
                finalReplyText = summary;
                logger.info(`Summarization successful (${finalReplyText.length} chars).`);
            } else {
                logger.warn(`Summarization failed or returned empty for ${triggerType} response. Falling back to truncation.`);
                const availableLength = MAX_IRC_MESSAGE_LENGTH - replyPrefix.length - 3;
                finalReplyText = initialResponseText.substring(0, availableLength < 0 ? 0 : availableLength) + '...';
            }
        }

        // d. Final length check and Send
        let finalMessage = replyPrefix + finalReplyText;
        if (finalMessage.length > MAX_IRC_MESSAGE_LENGTH) {
             logger.warn(`Final reply (even after summary/truncation) too long (${finalMessage.length} chars). Truncating sharply.`);
             finalMessage = finalMessage.substring(0, MAX_IRC_MESSAGE_LENGTH - 3) + '...';
        }
        await ircClient.say(channel, finalMessage);

    } catch (error) {
        logger.error({ err: error, channel: cleanChannel, user: lowerUsername, trigger: triggerType }, `Error processing standard LLM query.`);
        try {
            const ircClient = getIrcClient();
            await ircClient.say(channel, `@${displayName} Sorry, an error occurred while processing that.`);
        } catch (sayError) { logger.error({ err: sayError }, 'Failed to send LLM error message to chat.'); }
    }
}
