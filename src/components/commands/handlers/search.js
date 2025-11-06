import logger from '../../../lib/logger.js';
// Import context manager and prompt builder
import { getContextManager } from '../../context/contextManager.js';
import { buildContextPrompt, summarizeText, getOrCreateChatSession } from '../../llm/geminiClient.js';
import { removeMarkdownAsterisks } from '../../llm/llmUtils.js';
import { enqueueMessage } from '../../../lib/ircSender.js';

// Define IRC message length limit (be conservative)
const MAX_IRC_MESSAGE_LENGTH = 450;
// Target length for summaries (should be less than MAX_IRC_MESSAGE_LENGTH)
const SUMMARY_TARGET_LENGTH = 400;

/**
 * Handler for the !search command.
 * Fetches context, then asks Gemini to search Google and returns the result.
 */
const searchHandler = {
    name: 'search',
    description: 'Searches the web for information on a topic.',
    usage: '!search <your query>',
    permission: 'everyone', // Or restrict if desired (e.g., 'subscriber')
    execute: async (context) => {
        const { channel, user, args } = context;
        const userQuery = args.join(' ').trim();
        const channelName = channel.substring(1); // Remove #
        const userName = user['display-name'] || user.username; // Get username for replies
        const replyToId = user?.id || user?.['message-id'] || null;
        const contextManager = getContextManager(); // Get context manager

        if (!userQuery) {
            enqueueMessage(channel, `Please provide something to search for. Usage: !search <your query>`, { replyToId });
            return;
        }

        logger.info(`Executing !search command for ${userName} in ${channel} with query: "${userQuery}"`);

        try {
            // 1. Get Context
            const llmContext = contextManager.getContextForLLM(channelName, userName, `searching for: ${userQuery}`); // Get context object
            if (!llmContext) {
                logger.warn(`[${channelName}] Could not get context for !search command from user ${userName}.`);
                enqueueMessage(channel, `Sorry, I couldn't retrieve the current context to perform the search.`, { replyToId });
                return;
            }
            const contextPrompt = buildContextPrompt(llmContext); // Build context string

            // Get raw chat history from context manager for initializing session history
            const channelStates = contextManager.getAllChannelStates();
            const channelState = channelStates.get(channelName);
            const rawChatHistory = channelState?.chatHistory || [];

            // 2. Use the persistent chat session with googleSearch tool enabled
            // Pass context and chat history so bot has stream context and recent chat history when first created
            const chatSession = getOrCreateChatSession(channelName, contextPrompt, rawChatHistory);
            const fullPrompt = `${contextPrompt}\n\nUSER: ${userName} is explicitly asking to search for: "${userQuery}"\nReference chat history by username when relevant.`;
            const result = await chatSession.sendMessage({ message: fullPrompt });
            const initialResponseText = typeof result?.text === 'function' ? result.text() : (typeof result?.text === 'string' ? result.text : '');

            // Log Google Search grounding metadata and citations if present
            try {
                const candidate = result?.candidates?.[0];
                const groundingMetadata = candidate?.groundingMetadata || result?.candidates?.[0]?.groundingMetadata;
                if (groundingMetadata) {
                    const sources = Array.isArray(groundingMetadata.groundingChunks)
                        ? groundingMetadata.groundingChunks.slice(0, 3).map(c => c?.web?.uri).filter(Boolean)
                        : undefined;
                    logger.info({ usedGoogleSearch: true, webSearchQueries: groundingMetadata.webSearchQueries, sources }, '[SearchCmd] Search grounding metadata.');
                } else {
                    logger.info({ usedGoogleSearch: false }, '[SearchCmd] No search grounding metadata present.');
                }
                if (candidate?.citationMetadata?.citationSources?.length > 0) {
                    logger.info({ citations: candidate.citationMetadata.citationSources }, '[SearchCmd] Response included citations.');
                }
            } catch (logErr) {
                logger.debug({ err: logErr }, '[SearchCmd] Skipped grounding/citation logging due to unexpected response shape.');
            }

            if (!initialResponseText || initialResponseText.trim().length === 0) {
                logger.warn(`LLM returned no result for search query: "${userQuery}"`);
                enqueueMessage(channel, `Sorry, I couldn't find information about "${userQuery}" right now.`, { replyToId });
                return; // Exit if no initial response
            }

            // 3. Format the initial reply and check length (prefix simplified)
            let finalReplyText = initialResponseText;
            // Strip mistaken @mentions of the user if present
            finalReplyText = finalReplyText.replace(new RegExp(`^@?${userName.toLowerCase()}[,:]?\\s*`, 'i'), '').trim();
            // Remove markdown asterisks
            finalReplyText = removeMarkdownAsterisks(finalReplyText);

            if (finalReplyText.length > MAX_IRC_MESSAGE_LENGTH) {
                logger.info(`Initial search response too long (${finalReplyText.length} chars). Attempting summarization.`);

                const summary = await summarizeText(finalReplyText, SUMMARY_TARGET_LENGTH);

                if (summary && summary.trim().length > 0) {
                    finalReplyText = summary;
                    logger.info(`Summarization successful (${finalReplyText.length} chars).`);
                } else {
                    logger.warn(`Summarization failed for query: "${userQuery}". Falling back to intelligent truncation.`);
                    const availableLength = MAX_IRC_MESSAGE_LENGTH - 3;
                    
                    if (availableLength > 0) {
                        let truncated = initialResponseText.substring(0, availableLength);
                        
                        // Try to find sentence endings first
                        const sentenceEndRegex = /[.!?][^.!?]*$/;
                        const sentenceMatch = truncated.match(sentenceEndRegex);
                        
                        if (sentenceMatch) {
                            const endIndex = availableLength - sentenceMatch[0].length + 1;
                            truncated = initialResponseText.substring(0, endIndex > 0 ? endIndex : 0);
                        } else {
                            // Try to find a comma or other natural break
                            const commaBreakRegex = /,[^,]*$/;
                            const commaMatch = truncated.match(commaBreakRegex);
                            
                            if (commaMatch) {
                                const endIndex = availableLength - commaMatch[0].length + 1;
                                truncated = initialResponseText.substring(0, endIndex > 0 ? endIndex : 0);
                            } else {
                                // Find the last space to avoid cutting off mid-word
                                const lastSpaceIndex = truncated.lastIndexOf(' ');
                                if (lastSpaceIndex > availableLength * 0.8) {
                                    truncated = initialResponseText.substring(0, lastSpaceIndex);
                                }
                                // If no good break point, keep the substring truncation
                            }
                        }
                        
                        finalReplyText = truncated + '...';
                    } else {
                        finalReplyText = '...';
                    }
                }
            }

            // 4. Final length check & Send
            let finalMessage = finalReplyText;
            if (finalMessage.length > MAX_IRC_MESSAGE_LENGTH) {
                logger.warn(`Final reply (even after summary/truncation) too long (${finalMessage.length} chars). Truncating sharply.`);
                finalMessage = finalMessage.substring(0, MAX_IRC_MESSAGE_LENGTH - 3) + '...';
            }
            enqueueMessage(channel, finalMessage, { replyToId });

        } catch (error) {
            logger.error({ err: error, command: 'search', query: userQuery }, `Error executing !search command.`);
            enqueueMessage(channel, `Sorry, an error occurred while searching.`, { replyToId });
        }
    },
};

export default searchHandler;