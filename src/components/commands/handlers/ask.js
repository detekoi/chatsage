import logger from '../../../lib/logger.js';
import { getContextManager } from '../../context/contextManager.js';
// Import the relevant functions from geminiClient
import {
    buildContextPrompt,
    decideSearchWithFunctionCalling,
    generateStandardResponse,
    generateSearchResponse,
    summarizeText,
    fetchIanaTimezoneForLocation
} from '../../llm/geminiClient.js';
import { getCurrentTime } from '../../../lib/timeUtils.js';
// Import the sender queue
import { enqueueMessage } from '../../../lib/ircSender.js';

// Define IRC message length limit (be conservative)
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
            enqueueMessage(channel, `@${userName}, please ask a question after the command. Usage: !ask <your question>`);
            return;
        }

        logger.info(`Executing !ask command for ${userName} in ${channel} with query: "${userQuery}"`);

        try {
            const llmContext = contextManager.getContextForLLM(channelName, userName, `asked: ${userQuery}`);
            if (!llmContext) {
                logger.warn(`[${channelName}] Could not get context for !ask command.`);
                enqueueMessage(channel, `@${userName}, sorry, I couldn't retrieve the current context.`);
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
                        await handleAskResponseFormatting(channel, userName, `The current time in ${locationForTime} is ${timeResult.currentTime}.`, userQuery);
                    } else {
                        await handleAskResponseFormatting(channel, userName, timeResult.error || `Sorry, I couldn't get the time for ${locationForTime} (using IANA: ${ianaTimezone}).`, userQuery);
                    }
                } else {
                    // Failed to get IANA from LLM, even though regex matched a location.
                    logger.warn(`[${channelName}] Regex extracted location "${locationForTime}", but LLM failed to find IANA. Falling back to general query.`);
                    const decisionResult = await decideSearchWithFunctionCalling(contextPrompt, userQuery);
                    let responseText = null;
                    if (decisionResult.searchNeeded) {
                        responseText = await generateSearchResponse(contextPrompt, userQuery);
                    } else {
                        responseText = await generateStandardResponse(contextPrompt, userQuery);
                    }
                    await handleAskResponseFormatting(channel, userName, responseText, userQuery);
                }
                return; // Time query handled (or attempt failed)
            }

            // --- Not a regex-matched time query. Proceed with general !ask logic. ---
            logger.debug(`[${channelName}] Query not matched by time regexes. Proceeding with general handling for: "${userQuery}"`);
            const decisionResult = await decideSearchWithFunctionCalling(contextPrompt, userQuery);
            logger.info({ decisionResult }, `Search decision made for general query: "${userQuery}"`);

            let responseText = null;
            if (decisionResult.searchNeeded) {
                logger.info(`Proceeding with search-grounded response for query: "${userQuery}"`);
                responseText = await generateSearchResponse(contextPrompt, userQuery);
            } else {
                logger.info(`Proceeding with standard (no search) response for query: "${userQuery}"`);
                responseText = await generateStandardResponse(contextPrompt, userQuery);
            }

            await handleAskResponseFormatting(channel, userName, responseText, userQuery);

        } catch (error) {
            logger.error({ err: error, command: 'ask', query: userQuery }, `Error executing !ask command.`);
            enqueueMessage(channel, `@${userName}, sorry, an error occurred while processing your question.`);
        }
    },
};

export default askHandler; // Still export as askHandler