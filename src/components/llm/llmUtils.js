import logger from '../../lib/logger.js';
import { logBotResponse } from '../../lib/activityLogger.js';
import { logConversation } from './conversationStorage.js';
import { getContextManager } from '../context/contextManager.js';
import { buildContextPrompt, summarizeText, getOrCreateChatSession, getChatSession } from './llmClient.js';
import { sendBotResponse } from './botResponseHandler.js';
import * as sharedChatManager from '../twitch/sharedChatManager.js';
import { pronounService } from '../../lib/pronounService.js';
import { retrieveMemories, formatMemoriesForPrompt } from '../memory/memoryManager.js';

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

const MAX_IRC_MESSAGE_LENGTH = 500; // Twitch IRC message limit
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


function stripTrackingParams(urlStr) {
  try {
    const u = new URL(urlStr);
    const keysToRemove = [];
    for (const key of u.searchParams.keys()) {
      if (key.startsWith('utm_') || key === 'gclid' || key === 'fbclid' || key === 'ref') {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(k => u.searchParams.delete(k));
    return u.toString();
  } catch {
    return urlStr;
  }
}

export function removeMarkdownAsterisks(text) {
  if (text == null) return '';
  // Markdown links (with optional surrounding parens like ([text](url))): convert to parenthesized clean URL
  text = text.replace(/\(?\[([^\]]+)\]\((https?:\/\/[^)]+)\)\)?/g, (match, linkText, url) => {
    return `(${stripTrackingParams(url)})`;
  });
  // Fallback for non-HTTP markdown links: [text](link) → text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Parenthesised full URLs: clean tracking params
  text = text.replace(/\((https?:\/\/[^)]+)\)/g, (match, url) => {
    return `(${stripTrackingParams(url)})`;
  });
  // Bold: **text** → text
  // eslint-disable-next-line no-useless-escape
  text = text.replace(/\*\*([^\*]+)\*\*/g, '$1');
  // Italic: *text* → text
  // eslint-disable-next-line no-useless-escape
  text = text.replace(/\*([^\*]+)\*/g, '$1');
  // Collapse multiple spaces left by removals
  text = text.replace(/ {2,}/g, ' ');
  return text.trim();
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
    // Reserve space for the period to ensure result doesn't exceed maxLength
    return text.substring(0, maxLength - 1).trim() + '.';
}

// Twitch caps a chat message at 500 chars, so a parent body never exceeds this; the
// guard only matters if a caller hands in something else.
const MAX_REPLY_PARENT_CHARS = 500;

/**
 * Looks up the Twitch shared-chat session a channel is currently part of, if any.
 * Never throws: a failed lookup is treated as "not in a shared session".
 * @param {string} cleanChannel - Channel name without '#'.
 * @returns {Promise<string|null>} The shared session ID, or null.
 */
export async function resolveSharedSessionId(cleanChannel) {
    try {
        const broadcasterId = await getContextManager().getBroadcasterId(cleanChannel);
        return (broadcasterId && sharedChatManager.getSessionForChannel(broadcasterId)) || null;
    } catch (err) {
        logger.debug({ err, channel: cleanChannel }, '[ChatSession] Could not resolve shared session, treating as single channel');
        return null;
    }
}

/**
 * Resolves the chat-session key for a channel: the shared-chat session ID when the
 * channel is in one, otherwise the channel name. Both mention handling and exchange
 * recording go through this, so they always land in the same session.
 * @param {string} cleanChannel - Channel name without '#'.
 * @returns {Promise<string>}
 */
export async function resolveChatSessionKey(cleanChannel) {
    return (await resolveSharedSessionId(cleanChannel)) || cleanChannel;
}

/**
 * Records a one-shot command exchange (e.g. "!game how do I update the firmware" and
 * the searched answer) into the channel's persistent chat session, so a follow-up
 * mention or reply is answered with that thread in view instead of cold.
 *
 * Only an existing session is written to. When none exists yet, the next
 * getOrCreateChatSession call seeds from the channel's recent chat history, which
 * already includes the bot's own message. Never throws: a missed record only means a
 * follow-up loses context, which must not break the command that just answered.
 * @param {string} cleanChannel - Channel name without '#'.
 * @param {string} displayName - Display name of the user who ran the command.
 * @param {string} userMessage - What the user typed, including the command (e.g. "!game how do I connect it").
 * @param {string} botReply - The text the bot sent to chat.
 */
export async function recordBotExchange(cleanChannel, displayName, userMessage, botReply) {
    try {
        if (!cleanChannel || !botReply?.trim() || !userMessage?.trim()) return;
        const sessionKey = await resolveChatSessionKey(cleanChannel);
        const chatSession = getChatSession(sessionKey);
        if (!chatSession || typeof chatSession.recordExchange !== 'function') {
            logger.debug({ channel: cleanChannel, sessionKey }, '[ChatSession] No live session to record command exchange into');
            return;
        }
        chatSession.recordExchange(`USER: ${displayName} says: ${userMessage}`, botReply);
        logger.debug({ channel: cleanChannel, sessionKey }, '[ChatSession] Recorded command exchange into chat session');
    } catch (err) {
        logger.warn({ err, channel: cleanChannel }, '[ChatSession] Failed to record command exchange');
    }
}

/**
 * Formats the message the user replied to so the model sees what "it" refers to.
 * @param {{displayName?: string, text?: string, isBot?: boolean}|null} replyParent
 * @returns {string|null}
 */
function formatReplyParent(replyParent) {
    const text = typeof replyParent?.text === 'string' ? replyParent.text.trim() : '';
    if (!text) return null;
    const clipped = text.length > MAX_REPLY_PARENT_CHARS ? `${text.slice(0, MAX_REPLY_PARENT_CHARS - 1)}…` : text;
    const who = replyParent.isBot ? 'your earlier message' : `${replyParent.displayName || 'another user'}'s message`;
    return `[Replying to ${who}: "${clipped}"]`;
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
 * @param {Array} emoteImageParts - Inline emote image parts for multimodal input.
 * @param {object} [options]
 * @param {{displayName?: string, text?: string, isBot?: boolean}|null} [options.replyParent] - The message
 *   this one is a Twitch reply to. Included in the turn so "how do I connect it" resolves against the
 *   answer it was sent under, even when that answer came from a one-shot command.
 */
export async function handleStandardLlmQuery(channel, cleanChannel, displayName, lowerUsername, userMessage, triggerType = "mention", replyToId = null, sessionId = null, emoteImageParts = [], options = {}) {
    const logContext = sessionId 
        ? { channel: cleanChannel, user: lowerUsername, trigger: triggerType, sessionId }
        : { channel: cleanChannel, user: lowerUsername, trigger: triggerType };
    
    logger.info(logContext, sessionId ? `[SharedChat:${sessionId}] Handling LLM query in shared session` : `Handling standard LLM query.`);
    const llmStartTime = Date.now();
    let wasSummarized = false;
    try {
        const contextManager = getContextManager();
        let llmContext;
        let chatSessionKey;

        // Fetch user pronouns
        const userLogin = lowerUsername || '';
        const grammar = await pronounService.getUserPronouns(userLogin);
        const userPronouns = grammar ? { display: grammar.display, grammar } : null;

        // a. Get context (merged or single-channel)
        // personaScope tells the chat session which channel(s) the persona comes
        // from. It is separate from chatSessionKey because a shared session keys
        // on a sessionId, which is not a channel and cannot resolve a persona.
        let personaScope;
        if (sessionId) {
            // Shared chat session - use merged context
            const session = sharedChatManager.getSession(sessionId);
            if (!session) {
                logger.warn({ sessionId }, 'Session ID provided but session not found');
                return;
            }

            // Get channel logins from participant IDs
            const channelLogins = session.participants.map(p => p.broadcaster_user_login);
            llmContext = contextManager.getMergedContextForLLM(channelLogins, displayName, userMessage, userPronouns);
            chatSessionKey = sessionId; // Use session ID as chat key
            personaScope = {
                hostChannelId: session.hostChannelId,
                participants: session.participants,
            };

            logger.debug({ sessionId, channels: channelLogins }, `Using merged context for shared session`);
        } else {
            // Single channel context
            llmContext = contextManager.getContextForLLM(cleanChannel, displayName, userMessage, userPronouns);
            chatSessionKey = cleanChannel;
            personaScope = { channelName: cleanChannel };
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
        // Also pass botLanguage so the system instruction includes the native-language directive
        const botLanguage = contextManager.getBotLanguage(cleanChannel) || null;
        const chatSession = getOrCreateChatSession(chatSessionKey, contextPrompt, rawChatHistory, botLanguage, personaScope);
        const replyParentLine = formatReplyParent(options?.replyParent);
        const messageForChat = replyParentLine
            ? `${replyParentLine}\nUSER: ${displayName} says: ${userMessage}`
            : `USER: ${displayName} says: ${userMessage}`;
        // Include emote images as inline multimodal parts if present
        const messageParts = [{ text: messageForChat }, ...emoteImageParts];

        // Long-term channel memory. The model will not ask about a term it thinks it already
        // knows, so matching lore is handed over up front. A memory failure never blocks a reply.
        let memoryContext = null;
        try {
            const recentText = (contextManager.getAllChannelStates().get(cleanChannel)?.chatHistory || [])
                .slice(-5)
                .map(msg => msg.message)
                .join('\n');
            const memories = await retrieveMemories(cleanChannel, { text: userMessage, username: lowerUsername, recentText });
            memoryContext = formatMemoriesForPrompt(memories);
            if (memoryContext) {
                logger.info({ ...logContext, memoryIds: memories.map(m => m.id) }, '[Memory] Channel memory added to LLM turn');
            }
        } catch (memoryErr) {
            logger.warn({ err: memoryErr, channel: cleanChannel }, '[Memory] Retrieval failed, replying without channel memory');
        }

        const chatResult = await chatSession.sendMessage({ message: messageParts, ephemeralContext: memoryContext });
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
            wasSummarized = true;

            const summary = await summarizeText(stripMetaThoughts(initialResponseText), SUMMARY_TARGET_LENGTH);
            if (summary?.trim()) {
                finalReplyText = removeMarkdownAsterisks(summary);
                logger.info(`Summarization successful (${finalReplyText.length} chars).`);
            } else {
                logger.warn(`Summarization failed or returned empty for ${triggerType} response. Falling back to smart truncation.`);
                finalReplyText = smartTruncate(removeMarkdownAsterisks(initialResponseText), MAX_IRC_MESSAGE_LENGTH);
            }
        }

        // e. Final length check and Send
        if (finalReplyText.length > MAX_IRC_MESSAGE_LENGTH) {
             logger.warn(`Final reply (even after summary/truncation) too long (${finalReplyText.length} chars). Applying smart truncation.`);
             finalReplyText = smartTruncate(finalReplyText, MAX_IRC_MESSAGE_LENGTH);
        }
        // Skip post-hoc translation if the LLM already generated in the target language
        const skipTranslation = !!botLanguage;
        await sendBotResponse(channel, finalReplyText, { replyToId, skipTranslation });
        logBotResponse(cleanChannel, triggerType, {
            latencyMs: Date.now() - llmStartTime,
            responseLength: finalReplyText.length,
            summarized: wasSummarized,
        });

        // Fire-and-forget: store conversation pair for prompt engineering
        logConversation(cleanChannel, userMessage, finalReplyText, {
            trigger: triggerType,
            responseLength: finalReplyText.length,
            summarized: wasSummarized,
            latencyMs: Date.now() - llmStartTime,
        });

    } catch (error) {
        logger.error({ err: error, channel: cleanChannel, user: lowerUsername, trigger: triggerType }, `Error processing standard LLM query.`);
        try {
            const errorMessage = getUserFriendlyErrorMessage(error);
            await sendBotResponse(channel, errorMessage, { replyToId });
        } catch (sayError) { logger.error({ err: sayError }, 'Failed to send LLM error message to chat.'); }
    }
}