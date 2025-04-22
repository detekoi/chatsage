import logger from '../../lib/logger.js';
import { getGeminiClient } from '../llm/geminiClient.js'; // Use the initialized model
// Potentially import MAX_CHAT_HISTORY_LENGTH if needed for internal checks, but triggering is external
// import { MAX_CHAT_HISTORY_LENGTH } from './contextManager.js';

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
 * Creates a prompt specifically for asking the LLM to summarize chat history.
 * @param {string} formattedHistory - The chat history formatted as a single string.
 * @returns {string} The summarization prompt.
 */
function buildSummarizationPrompt(formattedHistory) {
    // Prompt asking the LLM to act as a summarizer for chat context
    return `You are an AI assistant tasked with summarizing Twitch chat conversations.
Your goal is to capture the main topics, questions asked, user sentiments, and overall flow concisely.
Focus on information that would be useful context for understanding future messages.
Ignore simple greetings or spam unless they form a significant pattern.

Conversation segment to summarize:
--- START OF SEGMENT ---
${formattedHistory}
--- END OF SEGMENT ---

Concise summary of the segment above:`;
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
    // The primary trigger logic is in contextManager, but this prevents unnecessary calls.
    if (!fullChatHistorySegment || fullChatHistorySegment.length < 10) { // Arbitrary minimum length
        logger.debug(`[${channelName}] History segment too short, skipping summarization.`);
        return null; // Indicate no summary generated
    }

    logger.info(`[${channelName}] Attempting to summarize chat history segment (${fullChatHistorySegment.length} messages)...`);

    const formattedHistory = formatHistoryForSummarization(fullChatHistorySegment);
    const prompt = buildSummarizationPrompt(formattedHistory);
    const model = getGeminiClient(); // Get the initialized model

    try {
        // Use generateContent directly here, maybe with slightly different generation params if needed
        const result = await model.generateContent(
             {
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                // Override generation config for potentially longer summaries? Or use defaults?
                // generationConfig: { maxOutputTokens: 500, temperature: 0.5 }
             }
             // Note: Specifying contents like this might be required if using chat history roles.
             // Simpler approach if just sending the prompt string works: await model.generateContent(prompt);
        );

        const response = result.response;

        // Check for blocks/errors similar to geminiClient.generateStandardResponse
        if (response.promptFeedback?.blockReason) {
            logger.warn({ channel: channelName, blockReason: response.promptFeedback.blockReason }, 'Summarization prompt blocked by Gemini safety settings.');
            return null;
        }
        if (!response.candidates || response.candidates.length === 0 || !response.candidates[0].content) {
             logger.warn({ channel: channelName, response }, 'Gemini summarization response missing candidates or content.');
             return null;
        }

        const candidate = response.candidates[0];
        if (candidate.finishReason !== 'STOP' && candidate.finishReason !== 'MAX_TOKENS') {
             logger.warn({ channel: channelName, finishReason: candidate.finishReason }, `Gemini summarization finished unexpectedly: ${candidate.finishReason}`);
              if (candidate.finishReason === 'SAFETY') {
                 logger.warn(`[${channelName}] Gemini summarization response content blocked due to safety settings.`);
             }
             return null;
        }

        const summaryText = candidate.content.parts.map(part => part.text).join('');
        logger.info(`[${channelName}] Successfully generated chat summary (${summaryText.length} chars).`);
        return summaryText.trim();

    } catch (error) {
        logger.error({ err: error, channel: channelName }, 'Error during Gemini API call for summarization.');
        // Add specific error handling/retry logic here if needed
        return null; // Indicate failure
    }
}

export { triggerSummarizationIfNeeded };