// Unused, !ask is aliased to !search
import logger from '../../../lib/logger.js';
// Need context to build the prompt
import { getContextManager } from '../../context/contextManager.js';
// Need the search-enabled function and the summarizer
import { generateSearchGroundedResponse, summarizeText } from '../../llm/geminiClient.js';

// Define IRC message length limit (be conservative)
const MAX_IRC_MESSAGE_LENGTH = 450;
// Target length for summaries (should be less than MAX_IRC_MESSAGE_LENGTH)
const SUMMARY_TARGET_LENGTH = 400;

/**
 * Builds the specific prompt for the !ask command, incorporating context and search instructions.
 * @param {object} context - Context object from getContextForLLM.
 * @param {string} userQuery - The user's actual question/query.
 * @returns {string} The fully formatted prompt string for the search-enabled call.
 */
function buildAskPrompt(context, userQuery) {
    // Use defaults for missing context parts
    const game = context.streamGame || "N/A";
    const title = context.streamTitle || "N/A";
    const tags = context.streamTags || "N/A";
    const summary = context.chatSummary || "No conversation summary available yet.";
    const history = context.recentChatHistory || "No recent messages.";
    const username = context.username || "User"; // Fallback username

    // --- Prompt Structure ---
    return `You are ChatSage, a friendly and wise AI assistant in a Twitch chat. Be concise and engaging.

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
Answer the user's question based on your knowledge, the chat history and current stream information provided above. If the existing context is insufficient to answer accurately, OR if the question asks for real-time data (like news), specific external facts, definitions, or detailed step-by-step instructions (like video game guides or walkthroughs), use Google Search results to find the necessary information. Prioritize information from your own knowledge and the provided context if it's sufficient, but rely on search results for specialized knowledge, game knowledge, current events, or obscure facts. Provide a direct answer to the question.

ChatSage Response:`;
}


/**
 * Handler for the !ask command (and !sage alias).
 * Takes user question, gets context, asks Gemini (with search enabled), and returns the result.
 */
const askHandler = {
    name: 'ask',
    aliases: ['sage'], // Define aliases here
    description: 'Ask ChatSage a question. It will use context and Google Search if needed. Usage: !ask <your question>',
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
            // Pass username from tags, not the formatted query user yet
            const llmContext = contextManager.getContextForLLM(channelName, userName, `asked: ${userQuery}`); // Provide some context for the message triggering this
            if (!llmContext) {
                 logger.warn(`[${channelName}] Could not get context for !ask command from user ${userName}.`);
                 await ircClient.say(channel, `@${userName}, sorry, I couldn't retrieve the current context to answer.`);
                 return;
            }

            // 2. Build the specific Ask Prompt
            const askPrompt = buildAskPrompt(llmContext, userQuery);

            // 3. Call search-enabled generation function
            const initialResponseText = await generateSearchGroundedResponse(askPrompt);

            if (!initialResponseText || initialResponseText.trim().length === 0) {
                logger.warn(`LLM returned no answer for !ask query: "${userQuery}"`);
                await ircClient.say(channel, `@${userName}, sorry, I couldn't come up with an answer for that right now.`);
                return;
            }

            // 4. Format reply, check length, summarize if needed
            let replyPrefix = `@${userName} `; // Keep prefix simple
            let finalReplyText = initialResponseText;

            if ((replyPrefix.length + finalReplyText.length) > MAX_IRC_MESSAGE_LENGTH) {
                logger.info(`Initial !ask response too long (${finalReplyText.length} chars). Attempting summarization.`);
                replyPrefix = `@${userName}: `; // Not indicating summary, just a prefix

                const summary = await summarizeText(initialResponseText, SUMMARY_TARGET_LENGTH);

                if (summary?.trim()) {
                    finalReplyText = summary;
                    logger.info(`Summarization successful (${finalReplyText.length} chars).`);
                } else {
                    logger.warn(`Summarization failed for !ask query: "${userQuery}". Falling back to truncation.`);
                    const availableLength = MAX_IRC_MESSAGE_LENGTH - replyPrefix.length - 3;
                    finalReplyText = initialResponseText.substring(0, availableLength < 0 ? 0 : availableLength) + '...';
                }
            }

            // 5. Final length check & Send
            let finalMessage = replyPrefix + finalReplyText;
            if (finalMessage.length > MAX_IRC_MESSAGE_LENGTH) {
                 logger.warn(`Final !ask reply too long (${finalMessage.length} chars). Truncating sharply.`);
                 finalMessage = finalMessage.substring(0, MAX_IRC_MESSAGE_LENGTH - 3) + '...';
            }

            await ircClient.say(channel, finalMessage);

        } catch (error) {
            logger.error({ err: error, command: 'ask', query: userQuery }, `Error executing !ask command.`);
            try {
                await ircClient.say(channel, `@${userName}, sorry, an error occurred while processing your question.`);
            } catch (sayError) { logger.error({ err: sayError }, 'Failed to send ask error message.'); }
        }
    },
};

export default askHandler;