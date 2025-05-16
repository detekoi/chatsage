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

            // --- New Time Query Handling Logic ---
            // Regex to roughly identify if the query is about time and mentions a location.
            const timeQueryRegex = /\b(what(?:'s| is) the time in|time in|current time in|what time is it in)\s+([^?]+)(?:\?|$)/i;
            const timeMatch = userQuery.match(timeQueryRegex);

            if (timeMatch && timeMatch[2]) {
                const locationForTime = timeMatch[2].replace(/[?]$/, '').trim(); // Extract location, remove trailing question mark
                logger.info(`[${channelName}] Detected time query for location: "${locationForTime}"`);

                const ianaTimezone = await fetchIanaTimezoneForLocation(locationForTime);

                if (ianaTimezone) {
                    const timeResult = getCurrentTime({ timezone: ianaTimezone });
                    if (timeResult.currentTime) {
                        await handleAskResponseFormatting(channel, userName, `The current time in ${locationForTime} (${ianaTimezone}) is ${timeResult.currentTime}.`, userQuery);
                    } else {
                        await handleAskResponseFormatting(channel, userName, timeResult.error || `Sorry, I couldn't get the time for ${locationForTime} using timezone ${ianaTimezone}.`, userQuery);
                    }
                } else {
                    // Fallback to general LLM if IANA timezone not found, but inform the user.
                    const decisionResult = await decideSearchWithFunctionCalling(contextPrompt, userQuery);
                    let responseText = null;
                    if (decisionResult.searchNeeded) {
                        responseText = await generateSearchResponse(contextPrompt, userQuery);
                    } else {
                        responseText = await generateStandardResponse(contextPrompt, userQuery);
                    }
                    await handleAskResponseFormatting(channel, userName, `I couldn't determine a specific timezone for "${locationForTime}", but here's what I found: ${responseText || 'No information available.'}`, userQuery);
                }
                return; // Handled time query
            }
            // --- End New Time Query Handling Logic ---

            // Original !ask logic for non-time queries (or time queries that didn't match the regex)
            const decisionResult = await decideSearchWithFunctionCalling(contextPrompt, userQuery);
            logger.info({ decisionResult }, `Search decision made for query: "${userQuery}"`);

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