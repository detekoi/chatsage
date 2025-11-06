import logger from '../../lib/logger.js';
import { getContextManager } from '../context/contextManager.js';
import { buildContextPrompt, summarizeText, getOrCreateChatSession } from './geminiClient.js';
import { sendBotResponse } from './botResponseHandler.js';
import * as sharedChatManager from '../twitch/sharedChatManager.js';

/**
 * Helper to generate user-friendly error messages based on error type
 */
export function getUserFriendlyErrorMessage(error) {
    const message = error?.message || '';

    // Network-level failures
    if (/fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(message)) {
        return "Sorry, I'm having trouble connecting right now. Please try again in a moment.";
    }

    // API timeouts
    if (/timeout|timed out/i.test(message)) {
        return "Sorry, that took too long to process. Please try again.";
    }

    // Rate limiting
    if (error?.status === 429 || /rate limit|too many requests/i.test(message)) {
        return "I'm getting too many requests right now. Please wait a moment and try again.";
    }

    // Service unavailable
    if (error?.status === 503 || /service unavailable/i.test(message)) {
        return "My AI service is temporarily unavailable. Please try again in a moment.";
    }

    // Generic fallback
    return "Sorry, an error occurred while processing that.";
}

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
  if (text == null) return '';
  // eslint-disable-next-line no-useless-escape
  text = text.replace(/\*\*([^\*]+)\*\*/g, '$1');
  // Remove *italics*
  // eslint-disable-next-line no-useless-escape
  text = text.replace(/\*([^\*]+)\*/g, '$1');
  return text;
}

/**
 * Intelligently truncates text at natural sentence boundaries.
 * Avoids using ellipsis (...) by finding the best break point.
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} Truncated text ending at sentence boundary
 */
export function smartTruncate(text, maxLength) {
    if (!text || typeof text !== 'string') return text;
    if (text.length <= maxLength) return text;

    // Try to find last complete sentence within limit
    const truncated = text.substring(0, maxLength);
    const sentenceEndMatch = truncated.match(/[.!?](?=\s|$)/g);

    if (sentenceEndMatch) {
        const lastSentenceEnd = truncated.lastIndexOf(sentenceEndMatch[sentenceEndMatch.length - 1]);
        if (lastSentenceEnd > maxLength * 0.7) { // Only use if we keep at least 70%
            return text.substring(0, lastSentenceEnd + 1).trim();
        }
    }

    // Try to break at comma or semicolon
    const punctuationMatch = truncated.match(/[,;](?=\s)/g);
    if (punctuationMatch) {
        const lastPunctuation = truncated.lastIndexOf(punctuationMatch[punctuationMatch.length - 1]);
        if (lastPunctuation > maxLength * 0.8) {
            return text.substring(0, lastPunctuation + 1).trim();
        }
    }

    // Break at last space
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > maxLength * 0.8) {
        return text.substring(0, lastSpace).trim() + '.';
    }

    // Hard truncation as last resort (add period for completeness)
    return truncated.trim() + '.';
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
 * @param {string|null} sessionId - Optional shared chat session ID for merged context.
 */
export async function handleStandardLlmQuery(channel, cleanChannel, displayName, lowerUsername, userMessage, triggerType = "mention", replyToId = null, sessionId = null) {
    const logContext = sessionId 
        ? { channel: cleanChannel, user: lowerUsername, trigger: triggerType, sessionId }
        : { channel: cleanChannel, user: lowerUsername, trigger: triggerType };
    
    logger.info(logContext, sessionId ? `[SharedChat:${sessionId}] Handling LLM query in shared session` : `Handling standard LLM query.`);
    
    try {
        const contextManager = getContextManager();
        let llmContext;
        let chatSessionKey;

        // a. Get context (merged or single-channel)
        if (sessionId) {
            // Shared chat session - use merged context
            const session = sharedChatManager.getSession(sessionId);
            if (!session) {
                logger.warn({ sessionId }, 'Session ID provided but session not found');
                return;
            }

            // Get channel logins from participant IDs
            const channelLogins = session.participants.map(p => p.broadcaster_user_login);
            llmContext = contextManager.getMergedContextForLLM(channelLogins, displayName, userMessage);
            chatSessionKey = sessionId; // Use session ID as chat key
            
            logger.debug({ sessionId, channels: channelLogins }, `Using merged context for shared session`);
        } else {
            // Single channel context
            llmContext = contextManager.getContextForLLM(cleanChannel, displayName, userMessage);
            chatSessionKey = cleanChannel;
        }

        if (!llmContext) {
            logger.warn(logContext, 'Could not retrieve context for LLM response.');
            return;
        }

        // b. Build context prompt string
        const contextPrompt = buildContextPrompt(llmContext);

        // For single-channel sessions, seed initial chat history when creating the chat
        let rawChatHistory = null;
        if (!sessionId) {
            const channelStates = contextManager.getAllChannelStates();
            const channelState = channelStates.get(cleanChannel);
            rawChatHistory = channelState?.chatHistory || [];
        }

        // c. Use persistent chat session, passing context and (if applicable) history for initialization
        const chatSession = getOrCreateChatSession(chatSessionKey, contextPrompt, rawChatHistory);
        const messageForChat = `USER: ${displayName} says: ${userMessage}`;
        const chatResult = await chatSession.sendMessage({ message: messageForChat });
        let initialResponseText = typeof chatResult?.text === 'function' ? chatResult.text() : (typeof chatResult?.text === 'string' ? chatResult.text : '');

        // Log Google Search grounding metadata and citations if present
        try {
          const responseObj = chatResult;
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
                finalReplyText = removeMarkdownAsterisks(initialResponseText.substring(0, MAX_IRC_MESSAGE_LENGTH - 3) + '...');
            }
        }

        // e. Final length check and Send
        if (finalReplyText.length > MAX_IRC_MESSAGE_LENGTH) {
             logger.warn(`Final reply (even after summary/truncation) too long (${finalReplyText.length} chars). Truncating sharply.`);
             finalReplyText = removeMarkdownAsterisks(finalReplyText.substring(0, MAX_IRC_MESSAGE_LENGTH - 3) + '...');
        }
        await sendBotResponse(channel, finalReplyText, { replyToId });

    } catch (error) {
        logger.error({ err: error, channel: cleanChannel, user: lowerUsername, trigger: triggerType }, `Error processing standard LLM query.`);
        try {
            const errorMessage = getUserFriendlyErrorMessage(error);
            await sendBotResponse(channel, errorMessage, { replyToId });
        } catch (sayError) { logger.error({ err: sayError }, 'Failed to send LLM error message to chat.'); }
    }
}