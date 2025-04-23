import logger from '../../../lib/logger.js';
// Need context manager to get the current game
import { getContextManager } from '../../context/contextManager.js';
// Need LLM functions for search and summarization, and context builder
import { buildContextPrompt, generateSearchResponse, summarizeText } from '../../llm/geminiClient.js';
// Need message queue
import { enqueueMessage } from '../../../lib/ircSender.js';

const MAX_IRC_MESSAGE_LENGTH = 450;
const SUMMARY_TARGET_LENGTH = 400;

/**
 * Handler for the !game command.
 * Retrieves the current game from context and provides researched info via LLM search.
 */
const gameHandler = {
    name: 'game',
    description: 'Provides researched information about the game currently being played.',
    usage: '!game',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user } = context;
        const channelName = channel.substring(1);
        const userName = user['display-name'] || user.username;
        const contextManager = getContextManager();

        logger.info(`Executing !game command for ${userName} in ${channel}`);

        try {
            // 1. Get Context, specifically the game name
            const llmContext = contextManager.getContextForLLM(channelName, userName, "!game command request"); // Get context object
            if (!llmContext) {
                logger.warn(`[${channelName}] Could not get context for !game command.`);
                enqueueMessage(channel, `@${userName}, sorry, I couldn't retrieve the current context.`);
                return;
            }

            const currentGameName = llmContext.streamGame; // Get game name from the context object

            if (!currentGameName || currentGameName === "N/A") {
                logger.info(`[${channelName}] No current game set in context for !game command.`);
                enqueueMessage(channel, `@${userName}, I don't see a game set for the stream right now.`);
                return;
            }

            // 2. Build Context Prompt String (to provide background to the LLM)
            const contextPrompt = buildContextPrompt(llmContext);

            // 3. Formulate the specific query about the game for the LLM
            const gameQuery = `Tell me something interesting or provide a brief overview about the game: "${currentGameName}"`;
            logger.debug({ gameQuery }, `Formulated query for !game command.`);

            // 4. Call the search-enabled LLM function
            // Pass the context string and the specific game query
            const initialResponseText = await generateSearchResponse(contextPrompt, gameQuery);

            if (!initialResponseText?.trim()) {
                logger.warn(`LLM returned no result for !game query about "${currentGameName}"`);
                enqueueMessage(channel, `@${userName}, sorry, I couldn't find specific info about "${currentGameName}" right now.`);
                return;
            }

            // 5. Format reply, check length, summarize if needed
            let replyPrefix = `@${userName} `;
            let finalReplyText = initialResponseText;

            if ((replyPrefix.length + finalReplyText.length) > MAX_IRC_MESSAGE_LENGTH) {
                logger.info(`Initial !game response too long (${finalReplyText.length} chars). Attempting summarization.`);
                replyPrefix = `@${userName} `; // Invisible prefix for the summary

                const summary = await summarizeText(finalReplyText, SUMMARY_TARGET_LENGTH);
                if (summary?.trim()) {
                    finalReplyText = summary;
                    logger.info(`Summarization successful (${finalReplyText.length} chars).`);
                } else {
                    logger.warn(`Summarization failed for !game response about "${currentGameName}". Falling back to truncation.`);
                    const availableLength = MAX_IRC_MESSAGE_LENGTH - replyPrefix.length - 3;
                    finalReplyText = initialResponseText.substring(0, availableLength < 0 ? 0 : availableLength) + '...';
                }
            }

            // 6. Final length check & Enqueue
            let finalMessage = replyPrefix + finalReplyText;
            if (finalMessage.length > MAX_IRC_MESSAGE_LENGTH) {
                 logger.warn(`Final !game reply too long (${finalMessage.length} chars). Truncating sharply.`);
                 finalMessage = finalMessage.substring(0, MAX_IRC_MESSAGE_LENGTH - 3) + '...';
            }
            enqueueMessage(channel, finalMessage);

        } catch (error) {
            logger.error({ err: error, command: 'game' }, `Error executing !game command.`);
            enqueueMessage(channel, `@${userName}, sorry, an error occurred while fetching game info.`);
        }
    },
};

export default gameHandler;