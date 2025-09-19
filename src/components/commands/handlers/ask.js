import logger from '../../../lib/logger.js';
import { getContextManager } from '../../context/contextManager.js';
// Import the relevant functions from geminiClient
import {
    buildContextPrompt,
    generateSearchResponse,
    generateStandardResponse,
    decideSearchWithStructuredOutput,
    generateUnifiedResponse,
    summarizeText,
    fetchIanaTimezoneForLocation
} from '../../llm/geminiClient.js';
import { getCurrentTime } from '../../../lib/timeUtils.js';
// Import the sender queue
import { enqueueMessage } from '../../../lib/ircSender.js';

// Define IRC message length limit
const MAX_IRC_MESSAGE_LENGTH = 450;
// Target length for summaries (should be less than MAX_IRC_MESSAGE_LENGTH)
const SUMMARY_TARGET_LENGTH = 400;

// --- Multilingual Time Query Regexes ---
// Each regex should aim to capture the location in a group.
// The structure is: { langCode: string, regex: RegExp, locationGroupIndex: number }
const multilingualTimeQueryPatterns = [
    // English
    { langCode: 'en', regex: /\b(?:what's the time in|time in|current time in|what time is it in|time for)\s+([\p{L}\p{N}\s\-'.]+)/ui, locationGroupIndex: 1 },

    // Spanish
    { langCode: 'es', regex: /\b(?:qu[ée] hora es en|hora en|hora actual en|hora para)\s+([\p{L}\p{N}\s\-'.]+)/ui, locationGroupIndex: 1 },

    // Portuguese
    { langCode: 'pt', regex: /\b(?:que horas s[ãa]o em|horas em|hora atual em|horas para)\s+([\p{L}\p{N}\s\-'.]+)/ui, locationGroupIndex: 1 },

    // German
    { langCode: 'de', regex: /\b(?:wie sp[äa]t ist es in|Uhrzeit in|aktuelle Uhrzeit in|Zeit f[üu]r)\s+([\p{L}\p{N}\s\-'.]+)/ui, locationGroupIndex: 1 },

    // French
    { langCode: 'fr', regex: /\b(?:quelle heure est-il [àa]|heure [àa]|heure actuelle [àa]|l'heure pour|l'heure de)\s+([\p{L}\p{N}\s\-'.]+)/ui, locationGroupIndex: 1 },

    // Italian
    { langCode: 'it', regex: /\b(?:che ora [èe] a(?:d)?|che ore sono a(?:d)?|ora attuale a(?:d)?|l'ora per)\s+([\p{L}\p{N}\s\-'.]+)/ui, locationGroupIndex: 1 },

    // Russian
    { langCode: 'ru', regex: /(?:сколько времени в|время в|который час в|время для)\s+([\p{L}\p{N}\s\-'.]+)/ui, locationGroupIndex: 1 },
    { langCode: 'ru', regex: /([\p{L}\p{N}\s\-'.]+)\s*(?:сколько времени|который час)/ui, locationGroupIndex: 1 },

    // Japanese
    { langCode: 'ja', regex: /([\p{L}\p{N}\s\-'.]+)は\s*(?:何時|なんじ)\s*(?:ですか|か)?/ui, locationGroupIndex: 1 },
    { langCode: 'ja', regex: /([\p{L}\p{N}\s\-'.]+)の\s*(?:時間|時刻)\s*(?:は\s*(?:何時|なんじ)\s*(?:ですか|か)?)?/ui, locationGroupIndex: 1 },
    { langCode: 'ja', regex: /(?:何時|なんじ)\s*(?:ですか|か)?\s*([\p{L}\p{N}\s\-'.]+)/ui, locationGroupIndex: 1 },
    { langCode: 'ja', regex: /([\p{L}\p{N}\s\-'.]+)(?:何時|なんじ)/ui, locationGroupIndex: 1 },
    { langCode: 'ja', regex: /現在の\s*([\p{L}\p{N}\s\-'.]+)の\s*(?:時刻|時間)/ui, locationGroupIndex: 1 },
    { langCode: 'ja', regex: /([\p{L}\p{N}\s\-'.]+)\s*今\s*(?:何時|なんじ)\s*(?:ですか|か)?/ui, locationGroupIndex: 1 },
];

/**
 * Tries to extract a location from a user query using multilingual regex patterns.
 * @param {string} userQuery The user's chat message.
 * @returns {string|null} The extracted location name, or null if no match.
 */
function extractLocationFromTimeQuery(userQuery) {
    for (const pattern of multilingualTimeQueryPatterns) {
        const match = userQuery.match(pattern.regex);
        if (match && match[pattern.locationGroupIndex]) {
            const location = match[pattern.locationGroupIndex].replace(/[?¿!]$/, '').trim();
            if (location) {
                logger.debug(`[askHandler] Matched time query for lang ${pattern.langCode}, location: "${location}"`);
                return location;
            }
        }
    }
    return null;
}

/**
 * Handles formatting, length checking, summarization, and sending the response.
 * @param {string} channel - Channel to send to (# included).
 * @param {string} userName - User to respond to.
 * @param {string | null} responseText - The LLM response text.
 * @param {string} userQuery - The original query for context.
 */
async function handleAskResponseFormatting(channel, userName, responseText, userQuery, replyToId) {
    logger.info({ responseText: responseText?.substring(0, 100), userQuery }, `handleAskResponseFormatting called for ${userName}`);
    
    if (!responseText?.trim()) {
        logger.warn(`LLM returned no answer for !ask query "${userQuery}" from ${userName}`);
        enqueueMessage(channel, `Sorry, I couldn't find or generate an answer for that right now.`, { replyToId });
        return;
    }

    let finalReplyText = responseText;

    // Strip any mistaken prefixes from the LLM response
    finalReplyText = finalReplyText.replace(new RegExp(`^@?${userName.toLowerCase()}[,:]?\\s*`, 'i'), '').trim();

    if (finalReplyText.length > MAX_IRC_MESSAGE_LENGTH) {
        logger.info(`Initial !ask response too long (${finalReplyText.length} chars). Attempting summarization.`);

        const summary = await summarizeText(finalReplyText, SUMMARY_TARGET_LENGTH);
        if (summary && typeof summary === 'string' && summary.trim().length > 0) {
            finalReplyText = summary.trim();
            logger.info(`Summarization successful: reduced from ${finalReplyText.length} to ${summary.length} chars.`);
        } else {
            logger.warn(`Summarization failed for !ask response (got: ${typeof summary}). Falling back to intelligent truncation of original text.`);

            // Ensure we're working with the original response text for truncation
            const originalText = responseText || finalReplyText;
            const availableLength = MAX_IRC_MESSAGE_LENGTH - 3; // Reserve space for '...'

            if (availableLength > 0 && originalText.length > 0) {
                let truncated = originalText.substring(0, availableLength);

                // Try to find sentence endings first for natural breaks
                const sentenceEndRegex = /[.!?]\s*$/;
                if (!sentenceEndRegex.test(truncated)) {
                    // Find the last sentence ending within our limit
                    const lastSentenceEnd = Math.max(
                        truncated.lastIndexOf('. '),
                        truncated.lastIndexOf('! '),
                        truncated.lastIndexOf('? ')
                    );

                    if (lastSentenceEnd > availableLength * 0.6) {
                        truncated = originalText.substring(0, lastSentenceEnd + 1).trim();
                    } else {
                        // Try to find a comma or other natural break
                        const lastComma = truncated.lastIndexOf(', ');
                        if (lastComma > availableLength * 0.7) {
                            truncated = originalText.substring(0, lastComma).trim();
                        } else {
                            // Find the last space to avoid cutting off mid-word
                            const lastSpaceIndex = truncated.lastIndexOf(' ');
                            if (lastSpaceIndex > availableLength * 0.8) {
                                truncated = originalText.substring(0, lastSpaceIndex).trim();
                            }
                            // If no good break point found, keep the substring truncation
                        }
                    }
                }

                finalReplyText = truncated + '...';
                logger.info(`Applied intelligent truncation: ${originalText.length} -> ${finalReplyText.length} chars.`);
            } else {
                logger.error(`Cannot truncate: availableLength=${availableLength}, originalTextLength=${originalText?.length || 0}`);
                finalReplyText = 'Sorry, response too long to display.';
            }
        }
    }

    // Final safety check to ensure message fits within IRC limits
    let finalMessage = finalReplyText;
    if (finalMessage.length > MAX_IRC_MESSAGE_LENGTH) {
        logger.warn(`Final !ask reply still too long (${finalMessage.length} chars). Applying emergency truncation.`);
        const emergencyLength = MAX_IRC_MESSAGE_LENGTH - 3;
        if (emergencyLength > 0) {
            // Try to preserve word boundaries even in emergency truncation
            let emergencyTruncated = finalMessage.substring(0, emergencyLength);
            const lastSpace = emergencyTruncated.lastIndexOf(' ');
            if (lastSpace > emergencyLength * 0.8) {
                emergencyTruncated = finalMessage.substring(0, lastSpace);
            }
            finalMessage = emergencyTruncated + '...';
        } else {
            finalMessage = '...';
        }
    }

    enqueueMessage(channel, finalMessage, { replyToId });
}

/**
 * Handler for the !ask command using function calling to decide on search.
 */
const askHandler = {
    name: 'ask',
    description: 'Ask ChatSage a question. Uses search intelligently and can fetch time for locations.',
    usage: '!ask <your question>',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, args } = context;
        const userQuery = args.join(' ').trim();
        const channelName = channel.substring(1);
        const userName = user['display-name'] || user.username;
        const contextManager = getContextManager();

        if (!userQuery) {
            enqueueMessage(channel, `Please ask a question after the command. Usage: !ask <your question>`, { replyToId: user?.id || user?.['message-id'] || null });
            return;
        }

        // Fast-path for simple greetings to avoid unnecessary LLM calls and token usage
        const greetingRegex = /^(hi|hello|hey|sup|yo|hola|bonjour|ciao|hallo|privet|konnichiwa|konbanwa|ohayo)\b[!.,\s]*$/i;
        if (greetingRegex.test(userQuery) && userQuery.length <= 20) {
            enqueueMessage(channel, `Hey there! What’s on your mind?`, { replyToId: user?.id || user?.['message-id'] || null });
            return;
        }

        logger.info(`Executing !ask command for ${userName} in ${channel} with query: "${userQuery}"`);

        try {
            const llmContext = contextManager.getContextForLLM(channelName, userName, `asked: ${userQuery}`);
            if (!llmContext) {
                logger.warn(`[${channelName}] Could not get context for !ask command.`);
                enqueueMessage(channel, `Sorry, I couldn't retrieve the current context.`, { replyToId: user?.id || user?.['message-id'] || null });
                return;
            }
            const contextPrompt = buildContextPrompt(llmContext);

            // --- Step 1: Try to extract location using multilingual regexes ---
            const locationForTime = extractLocationFromTimeQuery(userQuery);

            if (locationForTime) {
                logger.info(`[${channelName}] Detected time query via regex for location: "${locationForTime}"`);

                // --- Step 2: Fetch IANA timezone using the LLM (specialized call) ---
                const ianaTimezone = await fetchIanaTimezoneForLocation(locationForTime);

                if (ianaTimezone) {
                    // --- Step 3: Get current time using the IANA timezone ---
                    const timeResult = getCurrentTime({ timezone: ianaTimezone });
                    if (timeResult.currentTime) {
                        await handleAskResponseFormatting(channel, userName, `The current time in ${locationForTime} is ${timeResult.currentTime}.`, userQuery, user?.id || user?.['message-id'] || null);
                    } else {
                        await handleAskResponseFormatting(channel, userName, timeResult.error || `Sorry, I couldn't get the time for ${locationForTime} (using IANA: ${ianaTimezone}).`, userQuery, user?.id || user?.['message-id'] || null);
                    }
                } else {
                    // Failed to get IANA from LLM, even though regex matched a location.
                    logger.warn(`[${channelName}] Regex extracted location "${locationForTime}", but LLM failed to find IANA. Using unified generation.`);
                    const userQueryWithContext = `The user is ${userName}. Their message is: ${userQuery}`;
                    const responseText = await generateUnifiedResponse(contextPrompt, userQueryWithContext);
                    await handleAskResponseFormatting(channel, userName, responseText, userQuery, user?.id || user?.['message-id'] || null);
                }
                return; // Time query handled (or attempt failed)
            }

            // --- Not a regex-matched time query. Decide if search is needed, then route. ---
            const userQueryWithContext = `The user is ${userName}. Their message is: ${userQuery}`;
            const decision = await decideSearchWithStructuredOutput(contextPrompt, userQueryWithContext);
            logger.info({ searchNeeded: decision?.searchNeeded, reason: decision?.reasoning }, `[${channelName}] Search decision for !ask`);

            let responseText = null;
            if (decision?.searchNeeded) {
                // Do not require strict grounding signals; accept valid search answers even if metadata arrays are empty
                responseText = await generateSearchResponse(contextPrompt, userQueryWithContext, { requireGrounding: false });
                if (!responseText) {
                    // Fallback to standard if grounded response failed (e.g., safety block)
                    responseText = await generateStandardResponse(contextPrompt, userQueryWithContext);
                }
            } else {
                responseText = await generateStandardResponse(contextPrompt, userQueryWithContext);
            }

            await handleAskResponseFormatting(channel, userName, responseText, userQuery, user?.id || user?.['message-id'] || null);

        } catch (error) {
            logger.error({ err: error, command: 'ask', query: userQuery }, `Error executing !ask command.`);
            enqueueMessage(channel, `Sorry, an error occurred while processing your question.`, { replyToId: user?.id || user?.['message-id'] || null });
        }
    },
};

export default askHandler; // Still export as askHandler