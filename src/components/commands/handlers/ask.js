import logger from '../../../lib/logger.js';
import { getContextManager } from '../../context/contextManager.js';
import { generateResponse, generateSearchGroundedResponse, summarizeText } from '../../llm/geminiClient.js';

// Define IRC message length limit (be conservative)
const MAX_IRC_MESSAGE_LENGTH = 450;
// Target length for summaries (should be less than MAX_IRC_MESSAGE_LENGTH)
const SUMMARY_TARGET_LENGTH = 400;

/**
 * Builds the initial prompt for the LLM to determine if search is needed
 * @param {object} context - Context object from getContextForLLM
 * @param {string} userQuery - The user's actual question/query
 * @returns {string} The formatted prompt for function calling decision
 */
function buildFunctionCallingPrompt(context, userQuery) {
    // Use defaults for missing context parts
    const game = context.streamGame || "N/A";
    const title = context.streamTitle || "N/A";
    const tags = context.streamTags || "N/A";
    const summary = context.chatSummary || "No conversation summary available yet.";
    const history = context.recentChatHistory || "No recent messages.";
    const username = context.username || "User"; // Fallback username

    return `You are ChatSage, a helpful AI assistant in a Twitch chat. You need to determine whether a question requires Google Search to be answered accurately. 

**Current Stream Information:**
Game: ${game}
Title: ${title}
Tags: ${tags}

**Chat Summary:**
${summary}

**Recent Messages:**
${history}

---
**User's Question:**
${username} asked: "${userQuery}"
---

**Your Task:**
You must decide whether to use Google Search to answer this question. 

This is a CRITICAL decision. By default, assume you can answer the question WITHOUT search.

You SHOULD use Google Search ONLY if these conditions are met:

1. CURRENT EVENTS: The question asks about events, news, or information after your knowledge cutoff (October 2024)
2. REAL-TIME DATA: The question asks for current statistics, prices, weather, etc. that change regularly
3. SPECIFIC FACTS: The question asks for highly specific factual information that wouldn't be part of general knowledge (e.g., detailed specifications, exact data points, obscure information)
4. GAME-SPECIFIC: The question asks about specific features, mechanics or details of the game being streamed (${game})
5. RAPIDLY CHANGING TECH: The question is about technology that changes frequently (e.g., latest versions, new features)

You should NOT use Google Search if:
1. GENERAL KNOWLEDGE: The question is about concepts, principles, or widely known information
2. OPINIONS & CREATIVITY: The question asks for subjective views, creative content, or hypotheticals
3. LOGIC & REASONING: The question requires applying logic or reasoning to information you already know
4. CHAT CONTEXT: The question can be answered based on the chat history or stream information provided
5. ADVICE & SUGGESTIONS: The question asks for general advice or suggestions

Be conservative - only choose search if absolutely necessary to provide an accurate answer.

Respond with only one of these options:
"SEARCH_NEEDED" - the question clearly requires search to provide an accurate answer
"NO_SEARCH_NEEDED" - the question can be answered without search

Decision:`;
}

/**
 * Builds the specific prompt for answering without search
 * @param {object} context - Context object from getContextForLLM
 * @param {string} userQuery - The user's actual question/query
 * @returns {string} The formatted prompt string for non-search response
 */
function buildStandardAnswerPrompt(context, userQuery) {
    // Use defaults for missing context parts
    const game = context.streamGame || "N/A";
    const title = context.streamTitle || "N/A";
    const tags = context.streamTags || "N/A";
    const summary = context.chatSummary || "No conversation summary available yet.";
    const history = context.recentChatHistory || "No recent messages.";
    const username = context.username || "User"; // Fallback username

    return `You are ChatSage, a friendly and wise AI assistant in a Twitch chat. Be extremely concise and direct.

**Current Stream Information:**
Game: ${game}
Title: ${title}
Tags: ${tags}

**Chat Summary:**
${summary}

**Recent Messages:**
${history}

---
**User's Question:**
${username} asked: "${userQuery}"
---

**Your Task:**
Answer the user's question based on your knowledge, the chat history and current stream information provided above. Follow these rules carefully:

1. Be EXTREMELY CONCISE - Your response must be no more than 1-2 sentences if possible
2. Answer the specific question directly - don't add background or context unless absolutely necessary
3. Focus only on giving the exact information requested
4. Do not provide additional information beyond what was asked

ChatSage Response:`;
}

/**
 * Builds the specific prompt for the search-enabled response
 * @param {object} context - Context object from getContextForLLM
 * @param {string} userQuery - The user's actual question/query
 * @returns {string} The formatted prompt string for search-enabled call
 */
function buildSearchAnswerPrompt(context, userQuery) {
    // Use defaults for missing context parts
    const game = context.streamGame || "N/A";
    const title = context.streamTitle || "N/A";
    const tags = context.streamTags || "N/A";
    const summary = context.chatSummary || "No conversation summary available yet.";
    const history = context.recentChatHistory || "No recent messages.";
    const username = context.username || "User"; // Fallback username

    return `You are ChatSage, a friendly and wise AI assistant in a Twitch chat. Be extremely concise and direct.

**Current Stream Information:**
Game: ${game}
Title: ${title}
Tags: ${tags}

**Chat Summary:**
${summary}

**Recent Messages:**
${history}

---
**User's Question:**
${username} asked: "${userQuery}"
---

**Your Task:**
Answer the user's question using Google Search to find accurate, up-to-date information. Follow these rules carefully:

1. Be EXTREMELY CONCISE - Your response must be no more than 1-2 sentences if possible
2. Answer the specific question directly - don't add background or context unless absolutely necessary
3. Do not mention that you used search in your response
4. Focus only on giving the exact information requested
5. Do not provide additional information beyond what was asked

ChatSage Response:`;
}

/**
 * Handles format, length checking, summarization, and sending the response
 * @param {string} ircClient - IRC client for sending messages
 * @param {string} channel - Channel to send to
 * @param {string} userName - User to respond to
 * @param {string} responseText - The LLM response text to format and send
 */
async function handleResponseFormatting(ircClient, channel, userName, responseText, searchUsed = false) {
    // Check if we got a valid response
    if (!responseText || responseText.trim().length === 0) {
        logger.warn(`LLM returned no answer for !ask query from ${userName}`);
        await ircClient.say(channel, `@${userName}, sorry, I couldn't come up with an answer for that right now.`);
        return;
    }

    // Format reply, check length, summarize if needed
    let replyPrefix = searchUsed 
        ? `@${userName} `  // Don't indicate search was used
        : `@${userName} `;
    
    let finalReplyText = responseText;

    if ((replyPrefix.length + finalReplyText.length) > MAX_IRC_MESSAGE_LENGTH) {
        logger.info(`Initial !ask response too long (${finalReplyText.length} chars). Attempting summarization.`);

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

    // Final length check & Send
    let finalMessage = replyPrefix + finalReplyText;
    if (finalMessage.length > MAX_IRC_MESSAGE_LENGTH) {
        logger.warn(`Final !ask reply too long (${finalMessage.length} chars). Truncating sharply.`);
        finalMessage = finalMessage.substring(0, MAX_IRC_MESSAGE_LENGTH - 3) + '...';
    }

    await ircClient.say(channel, finalMessage);
}

/**
 * Handler for the new !ask command using function calling.
 * First determines if search is needed, then calls appropriate response generator.
 */
const askHandler = {
    name: 'ask',
    description: 'Ask ChatSage a question. It will intelligently decide whether to use Google Search. Usage: !ask <your question>',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, args, ircClient } = context;
        const userQuery = args.join(' ').trim();
        const channelName = channel.substring(1);
        const userName = user['display-name'] || user.username;
        const contextManager = getContextManager();

        if (!userQuery) {
            try {
                await ircClient.say(channel, `@${userName}, please ask a question after the command. Usage: !ask <your question>`);
            } catch (e) { logger.error({ err: e }, 'Failed to send ask usage message.'); }
            return;
        }

        logger.info(`Executing !ask command for ${userName} in ${channel} with query: "${userQuery}"`);

        try {
            // 1. Get Context
            const llmContext = contextManager.getContextForLLM(channelName, userName, `asked: ${userQuery}`);
            if (!llmContext) {
                logger.warn(`[${channelName}] Could not get context for !ask command from user ${userName}.`);
                await ircClient.say(channel, `@${userName}, sorry, I couldn't retrieve the current context to answer.`);
                return;
            }

            // 2. Build the function calling prompt and determine if search is needed
            const functionCallingPrompt = buildFunctionCallingPrompt(llmContext, userQuery);
            
            let decisionResponse;
            try {
                decisionResponse = await generateResponse({
                    ...llmContext,
                    currentMessage: functionCallingPrompt
                });
            } catch (error) {
                logger.warn({ err: error, query: userQuery }, 'Function calling decision failed');
                // Default to no search in case of error
                decisionResponse = 'NO_SEARCH_NEEDED';
            }
            
            // 3. Parse the decision
            let searchNeeded = false;
            if (decisionResponse && decisionResponse.includes("SEARCH_NEEDED")) {
                searchNeeded = true;
                logger.info({ 
                    query: userQuery,
                    decision: "SEARCH_NEEDED",
                    decisionRaw: decisionResponse.substring(0, 100) // Log beginning of response
                }, `Function calling determined search IS needed`);
            } else {
                logger.info({ 
                    query: userQuery,
                    decision: "NO_SEARCH_NEEDED",
                    decisionRaw: decisionResponse?.substring(0, 100) // Log beginning of response
                }, `Function calling determined search is NOT needed`);
            }

            // 4. Generate the appropriate response based on the decision
            let responseText;
            if (searchNeeded) {
                const searchPrompt = buildSearchAnswerPrompt(llmContext, userQuery);
                responseText = await generateSearchGroundedResponse(searchPrompt);
            } else {
                const standardPrompt = buildStandardAnswerPrompt(llmContext, userQuery);
                responseText = await generateResponse({
                    ...llmContext,
                    currentMessage: standardPrompt
                });
            }

            // 5. Format and send the response
            await handleResponseFormatting(ircClient, channel, userName, responseText, searchNeeded);

        } catch (error) {
            logger.error({ err: error, command: 'ask', query: userQuery }, `Error executing !ask command.`);
            try {
                await ircClient.say(channel, `@${userName}, sorry, an error occurred while processing your question.`);
            } catch (sayError) { logger.error({ err: sayError }, 'Failed to send ask error message.'); }
        }
    },
};

export default askHandler;