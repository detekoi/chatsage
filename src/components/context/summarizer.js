import logger from '../../lib/logger.js';
import { summarizeText } from '../llm/geminiClient.js'; // Use the specialized summarizeText function

/**
 * Formats chat history into a plain text block suitable for a summarization prompt.
 * @param {import('./contextManager.js').Message[]} chatHistory - Array of message objects.
 * @returns {string} A single string representation of the chat history.
 */
function formatHistoryForSummarization(chatHistory) {
    if (!chatHistory || chatHistory.length === 0) {
        return "No messages in this segment.";
    }
    // Simple format: User: Message\n
    return chatHistory.map(msg => `${msg.username}: ${msg.message}`).join('\n');
}


/**
 * Attempts to summarize the provided chat history using the LLM.
 * This function is typically called by the ContextManager when history grows large.
 *
 * @param {string} channelName - The channel the history belongs to (for logging).
 * @param {import('./contextManager.js').Message[]} fullChatHistorySegment - The segment of chat history to summarize.
 * @returns {Promise<string | null>} A promise resolving to the generated summary text, or null if summarization fails or isn't needed.
 */
async function triggerSummarizationIfNeeded(channelName, fullChatHistorySegment) {
    // Basic check: Don't summarize very short histories.
    if (!fullChatHistorySegment || fullChatHistorySegment.length < 10) {
        logger.debug(`[${channelName}] History segment too short, skipping summarization.`);
        return null;
    }

    logger.info(`[${channelName}] Attempting to summarize chat history segment (${fullChatHistorySegment.length} messages)...`);

    const formattedHistory = formatHistoryForSummarization(fullChatHistorySegment);

    try {
        // Use the specialized summarizeText function with a target length
        const targetLength = 300; // Keep summaries concise
        const summary = await summarizeText(formattedHistory, targetLength);

        if (summary && summary.trim().length > 0) {
            logger.info(`[${channelName}] Successfully generated chat summary (${summary.length} chars).`);
            return summary.trim();
        } else {
            logger.warn(`[${channelName}] Summarization returned empty result.`);
            return null;
        }

    } catch (error) {
        logger.error({ err: error, channel: channelName }, 'Error during summarization API call.');
        return null;
    }
}

export { triggerSummarizationIfNeeded };