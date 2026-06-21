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
 * When a previousSummary is provided, it is folded into the new summary so that
 * older context accumulates rather than being overwritten (rolling summary).
 *
 * @param {string} channelName - The channel the history belongs to (for logging).
 * @param {import('./contextManager.js').Message[]} fullChatHistorySegment - The segment of chat history to summarize (evicted messages only).
 * @param {string|null} [previousSummary] - The existing rolling summary to fold into.
 * @returns {Promise<string | null>} A promise resolving to the generated summary text, or null if summarization fails or isn't needed.
 */
async function triggerSummarizationIfNeeded(channelName, fullChatHistorySegment, previousSummary) {
    // Basic check: Don't summarize very short histories.
    if (!fullChatHistorySegment || fullChatHistorySegment.length < 10) {
        logger.debug(`[${channelName}] History segment too short, skipping summarization.`);
        return null;
    }

    // Normalize: state.chatSummary can be null, empty string, or undefined.
    // Use truthiness check — default params only cover undefined, not null.
    const priorSummary = previousSummary ? previousSummary.trim() : '';

    logger.info(`[${channelName}] Attempting to summarize chat history segment (${fullChatHistorySegment.length} messages) using map/reduce${priorSummary ? ' (folding previous summary)' : ''}...`);

    // Parameters for map/reduce
    const chunkSize = 20; // messages per chunk
    const mapTargetChars = 220; // per-chunk summary target
    const reduceTargetChars = 450; // final summary target (needs headroom for rolling accumulation)

    // Split into chunks
    const chunks = [];
    for (let i = 0; i < fullChatHistorySegment.length; i += chunkSize) {
        const slice = fullChatHistorySegment.slice(i, i + chunkSize);
        chunks.push(slice);
    }

    if (chunks.length === 1) {
        // Small enough: do a single summary
        const formatted = formatHistoryForSummarization(chunks[0]);
        // Fold in previous summary so older context accumulates
        const prompt = priorSummary
            ? `Previous context summary:\n${priorSummary}\n\nNew chat messages to incorporate:\n${formatted}`
            : formatted;
        try {
            const single = await summarizeText(prompt, reduceTargetChars);
            if (single && single.trim()) {
                logger.info(`[${channelName}] Single-pass summary generated (${single.length} chars).`);
                return single.trim();
            }
            logger.warn(`[${channelName}] Summarization returned empty result for single chunk.`);
            return null;
        } catch (error) {
            logger.error({ err: error, channel: channelName }, 'Error during single-pass summarization API call.');
            return null;
        }
    }

    // Map step: summarize each chunk in parallel
    const formattedChunks = chunks.map(formatHistoryForSummarization);
    let chunkSummaries;
    try {
        chunkSummaries = await Promise.all(
            formattedChunks.map((chunkText, idx) =>
                summarizeText(`Segment ${idx + 1} of ${formattedChunks.length}\n\n${chunkText}`, mapTargetChars)
                    .then(s => (s ? s.trim() : ''))
                    .catch(err => {
                        logger.error({ err, channel: channelName, chunkIndex: idx }, 'Error summarizing chunk.');
                        return '';
                    })
            )
        );
    } catch (error) {
        logger.error({ err: error, channel: channelName }, 'Parallel chunk summarization failed.');
        return null;
    }

    const validSummaries = chunkSummaries.filter(s => s && s.length > 0);
    if (validSummaries.length === 0) {
        logger.warn(`[${channelName}] All chunk summaries were empty.`);
        return null;
    }

    // Reduce step: summarize the summaries into a final concise summary
    // Fold in previous summary so older context accumulates across cycles
    const reduceInput = validSummaries
        .map((s, i) => `Chunk ${i + 1}: ${s}`)
        .join('\n');

    const reducePrompt = priorSummary
        ? `Previous context summary:\n${priorSummary}\n\nNew chunk summaries to incorporate:\n${reduceInput}\n\nCombine the previous context and new chunks into one concise, coherent summary that preserves key context.`
        : `Combine these chunk summaries into one concise, coherent summary that preserves key context.\n\n${reduceInput}`;

    try {
        const finalSummary = await summarizeText(
            reducePrompt,
            reduceTargetChars
        );

        if (finalSummary && finalSummary.trim()) {
            logger.info(`[${channelName}] Map/Reduce summary generated (${finalSummary.length} chars) from ${validSummaries.length} chunk summaries.`);
            return finalSummary.trim();
        } else {
            logger.warn(`[${channelName}] Reduce step returned empty result.`);
            return null;
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName }, 'Error during reduce summarization API call.');
        return null;
    }
}

export { triggerSummarizationIfNeeded };