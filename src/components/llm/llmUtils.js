import logger from '../../lib/logger.js';
import { getContextManager } from '../context/contextManager.js';
import { buildContextPrompt, summarizeText, getOrCreateChatSession } from './geminiClient.js';
import { sendBotResponse } from './botResponseHandler.js';

const MAX_IRC_MESSAGE_LENGTH = 450;
const SUMMARY_TARGET_LENGTH = 400;
// Removes chain-of-thought or meta sections the model may emit
function stripMetaThoughts(text) {
    if (!text || typeof text !== 'string') return text;
    let cleaned = text;
    // Common prefixes we never want to send
    const badPrefixes = [
        /^thinking process[:\-\s]/i,
        /^thought process[:\-\s]/i,
        /^reasoning[:\-\s]/i,
        /^analysis[:\-\s]/i,
        /^deliberate[:\-\s]/i,
        /^system prompt[:\-\s]/i,
        /^prompt[:\-\s]/i,
        /^instructions?[:\-\s]/i
    ];
    for (const re of badPrefixes) {
        cleaned = cleaned.replace(re, '');
    }
    // Heuristic: remove explicit numbered "thinking" steps
    cleaned = cleaned.replace(/^\s*\d+\)\s*(?:think|reason).+$/gim, '').trim();
    return cleaned;
}


export function removeMarkdownAsterisks(text) {
  // eslint-disable-next-line no-useless-escape
  text = text.replace(/\*\*([^\*]+)\*\*/g, '$1');
  // Remove *italics*
  // eslint-disable-next-line no-useless-escape
  text = text.replace(/\*([^\*]+)\*/g, '$1');
  return text;
}

/**
 * Handles getting context, calling the standard LLM, summarizing/truncating, and replying.
 * @param {string} channel - Channel name with '#'.
 * @param {string} cleanChannel - Channel name without '#'.
 * @param {string} displayName - User's display name.
 * @param {string} lowerUsername - User's lowercase username.
 * @param {string} userMessage - The user's message/prompt for the LLM.
 * @param {string} triggerType - For logging ("mention" or "command").
 * @param {string|null} replyToId - The ID of the message to reply to.
 */
export async function handleStandardLlmQuery(channel, cleanChannel, displayName, lowerUsername, userMessage, triggerType = "mention", replyToId = null) {
    logger.info({ channel: cleanChannel, user: lowerUsername, trigger: triggerType }, `Handling standard LLM query.`);
    try {
        const contextManager = getContextManager();

        // a. Get context
        const llmContext = contextManager.getContextForLLM(cleanChannel, displayName, userMessage);
        if (!llmContext) {
            logger.warn({ channel: cleanChannel, user: lowerUsername }, 'Could not retrieve context for LLM response.');
            // Maybe send an error message? For now, just return.
            return;
        }

        // b. Build context prompt string
        const contextPrompt = buildContextPrompt(llmContext);

        // c. Use persistent chat session, passing context for initialization
        const chatSession = getOrCreateChatSession(cleanChannel, contextPrompt);
        const messageForChat = `USER: ${displayName} says: ${userMessage}`;
        const chatResult = await chatSession.sendMessage(messageForChat);
        let initialResponseText = chatResult?.response?.text ? chatResult.response.text() : chatResult?.text?.();

        // Log Google Search grounding metadata and citations if present
        try {
          const responseObj = chatResult?.response;
          const candidate = responseObj?.candidates?.[0];
          const groundingMetadata = candidate?.groundingMetadata || responseObj?.candidates?.[0]?.groundingMetadata;
          if (groundingMetadata) {
            const sources = Array.isArray(groundingMetadata.groundingChunks)
              ? groundingMetadata.groundingChunks.slice(0, 3).map(c => c?.web?.uri).filter(Boolean)
              : undefined;
            logger.info({ usedGoogleSearch: true, webSearchQueries: groundingMetadata.webSearchQueries, sources }, '[StandardChat] Search grounding metadata.');
          } else {
            logger.info({ usedGoogleSearch: false }, '[StandardChat] No search grounding metadata present.');
          }
          if (candidate?.citationMetadata?.citationSources?.length > 0) {
            logger.info({ citations: candidate.citationMetadata.citationSources }, '[StandardChat] Response included citations.');
          }
        } catch (logErr) {
          logger.debug({ err: logErr }, '[StandardChat] Skipped grounding/citation logging due to unexpected response shape.');
        }

        // If even the retry fails, provide a fallback message
        if (!initialResponseText?.trim()) {
            logger.error(`[${cleanChannel}] LLM generated null or empty response after retry. Sending fallback.`);
            await sendBotResponse(channel, `I'm a bit stumped on that one! Try asking another way?`, { replyToId });
            return;
        }

        // d. Check length and Summarize if needed
        let finalReplyText = removeMarkdownAsterisks(stripMetaThoughts(initialResponseText));

        if (finalReplyText.length > MAX_IRC_MESSAGE_LENGTH) {
            logger.info(`Initial LLM response too long (${finalReplyText.length} chars). Attempting summarization.`);

            const summary = await summarizeText(stripMetaThoughts(initialResponseText), SUMMARY_TARGET_LENGTH);
            if (summary?.trim()) {
                finalReplyText = removeMarkdownAsterisks(summary);
                logger.info(`Summarization successful (${finalReplyText.length} chars).`);
            } else {
                logger.warn(`Summarization failed or returned empty for ${triggerType} response. Falling back to truncation.`);
                finalReplyText = initialResponseText.substring(0, MAX_IRC_MESSAGE_LENGTH - 3) + '...';
            }
        }

        // e. Final length check and Send
        if (finalReplyText.length > MAX_IRC_MESSAGE_LENGTH) {
             logger.warn(`Final reply (even after summary/truncation) too long (${finalReplyText.length} chars). Truncating sharply.`);
             finalReplyText = finalReplyText.substring(0, MAX_IRC_MESSAGE_LENGTH - 3) + '...';
        }
        await sendBotResponse(channel, finalReplyText, { replyToId });

    } catch (error) {
        logger.error({ err: error, channel: cleanChannel, user: lowerUsername, trigger: triggerType }, `Error processing standard LLM query.`);
        try {
            await sendBotResponse(channel, `Sorry, an error occurred while processing that.`, { replyToId });
        } catch (sayError) { logger.error({ err: sayError }, 'Failed to send LLM error message to chat.'); }
    }
}