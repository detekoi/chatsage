// src/components/commands/handlers/game.js
import logger from '../../../lib/logger.js';
// Need context manager to get the current game
import { getContextManager } from '../../context/contextManager.js';
// Need LLM functions for search, summarization, and context builder
import { buildContextPrompt, generateSearchResponse, generateStandardResponse, summarizeText } from '../../llm/geminiClient.js';
// Need image analysis functions
import { fetchStreamThumbnail } from '../../twitch/streamImageCapture.js';
import { getCurrentGameInfo } from '../../twitch/streamInfoPoller.js';
import { analyzeImage } from '../../llm/geminiImageClient.js';
// Need summarizer for image analysis results

// Need message queue
import { enqueueMessage } from '../../../lib/ircSender.js';
// Import markdown removal and smart truncation utilities
import { removeMarkdownAsterisks, smartTruncate } from '../../llm/llmUtils.js';

const MAX_IRC_MESSAGE_LENGTH = 450;
const SUMMARY_TARGET_LENGTH = 420; // Target length for summaries, leaving buffer for IRC limits

/**
 * Handler for the !game command.
 * Retrieves the current game from context and provides researched info via LLM search.
 * Can also analyze stream thumbnails using image recognition when requested.
 */
const gameHandler = {
    name: 'game',
    description: 'Provides information about the game currently being played. Add "analyze" to use AI image recognition on the stream.',
    usage: '!game [analyze] [your question]',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelName = channel.substring(1);
        const userName = user['display-name'] || user.username;
        const replyToId = user?.id || user?.['message-id'] || null;

        // --- Argument Parsing ---
        let analysisRequested = false;
        let helpQueryArgs = [];

        if (args.length > 0 && args[0].toLowerCase() === 'analyze') {
            analysisRequested = true;
            helpQueryArgs = args.slice(1); // Take args after 'analyze'
        } else {
            helpQueryArgs = args; // All args are potentially part of the help query
        }

        const helpQuery = helpQueryArgs.join(' ').trim();
        const helpRequested = helpQuery.length > 0;

        logger.info({
            command: 'game',
            channel: channelName,
            user: userName,
            analysisRequested,
            helpRequested,
            helpQuery: helpQuery || 'N/A'
        }, `Executing !game command`);

        try {
            // --- Execute Image Analysis if requested ---
            let imageAnalysisResult = null;
            if (analysisRequested) {
                imageAnalysisResult = await handleImageAnalysis(channel, channelName, userName, replyToId, !helpRequested);
                // If both analysis and help are requested, add a small delay to avoid message overlap
                if (helpRequested) await new Promise(resolve => setTimeout(resolve, 1200));
            }

            // --- Execute Help Search if requested ---
            if (helpRequested) {
            await handleGameHelpRequest(channel, channelName, userName, helpQuery, replyToId, imageAnalysisResult);
                return;
            }

            // --- Fallback: Handle !game with no analysis or help query ---
            if (!analysisRequested && !helpRequested) {
                const gameInfo = await getCurrentGameInfo(channelName);
                if (gameInfo && gameInfo.gameName !== 'Unknown' && gameInfo.gameName !== 'N/A') {
                    await handleGameInfoResponse(channel, channelName, userName, gameInfo, replyToId);
                } else {
                    logger.info(`[${channelName}] No current game set in context for basic !game command.`);
                    enqueueMessage(channel, `I don't see a game set for the stream right now.`, { replyToId });
                }
                return;
            }

        } catch (error) {
            logger.error({ err: error, command: 'game', analysisRequested, helpRequested }, `Error executing !game command flow.`);
            enqueueMessage(channel, `Sorry, an error occurred while processing the !game command.`, { replyToId });
        }
    },
};

/**
 * Handles image analysis for the game command with balanced text cleanup
 * @param {string} channel - Channel with # prefix
 * @param {string} channelName - Channel without # prefix
 * @param {string} userName - Display name of requesting user
 * @param {string|null} replyToId - Message ID to reply to
 * @param {boolean} sendToChat - Whether to send result to chat (true) or just return it (false)
 * @returns {Promise<string|null>} The analysis result, or null on error
 */
async function handleImageAnalysis(channel, channelName, userName, replyToId, sendToChat = true) {
    try {
        // Removed confirmation message to reduce chat verbosity
        // Get the official game info from the API/context FIRST
        const gameInfo = await getCurrentGameInfo(channelName);
        const officialGameName = (gameInfo?.gameName && gameInfo.gameName !== 'Unknown' && gameInfo.gameName !== 'N/A') ? gameInfo.gameName : null;
        
        if (!officialGameName) {
            enqueueMessage(channel, `Couldn't determine the current game. The channel might not be streaming a game.`, { replyToId });
            return;
        }
        
        // Fetch the stream thumbnail
        const thumbnailBuffer = await fetchStreamThumbnail(channelName);
        
        if (!thumbnailBuffer) {
            enqueueMessage(channel, `Couldn't fetch the stream thumbnail. The channel might be offline.`, { replyToId });
            return;
        }
        
        // --- Step 1: Initial Image Analysis ---
        // Prompt focuses purely on description now
        const initialAnalysisPrompt = `Describe the in-game scene from "${officialGameName}" in 1–2 sentences. Focus on game elements only; ignore overlays. Plain text.`;

        // Analyze the image with Gemini
        const initialAnalysisResult = await analyzeImage(thumbnailBuffer, initialAnalysisPrompt);

        if (!initialAnalysisResult || initialAnalysisResult.trim().length === 0) {
            enqueueMessage(channel, `AI couldn't analyze the ${officialGameName} gameplay initially.`, { replyToId });
            return;
        }
        logger.debug(`[${channelName}] Initial analysis for ${officialGameName}: "${initialAnalysisResult.substring(0,100)}..."`);

        // --- Step 2: Verify/Refine with Search Grounding ---
        let verifiedAnalysisResult = initialAnalysisResult; // Default to initial if verification fails
        try {
            logger.info(`[${channelName}] Verifying image analysis for ${officialGameName} using search grounding.`);
            // Get context for the verification call
            const contextManager = getContextManager();
            const llmContext = contextManager.getContextForLLM(channelName, userName, `Verifying image analysis of ${officialGameName}`);
            const contextPrompt = buildContextPrompt(llmContext || {});

            // --- REVISED VERIFICATION QUERY V3 ---
            // Focus on in-game elements, explicitly ignore overlays.
            const verificationQuery = `Refine this screenshot description for "${officialGameName}":
"${initialAnalysisResult}"

Rules: focus on in-game elements only (ignore overlays), fix only clear factual errors, output 1–2 sentences of plain text. Reply with the refined description only.`;

            const searchResult = await generateSearchResponse(contextPrompt, verificationQuery);

            if (searchResult && searchResult.trim().length > 0) {
                verifiedAnalysisResult = searchResult;
                logger.info(`[${channelName}] Analysis verified/refined.`);
            } else {
                logger.warn(`[${channelName}] Search verification step returned empty result. Using initial analysis.`);
            }
        } catch(verificationError) {
             logger.error({ err: verificationError }, `[${channelName}] Error during search verification step. Using initial analysis.`);
             // Keep verifiedAnalysisResult = initialAnalysisResult
        }

        // --- Step 3: Process and Format Final Result ---
        const prefixLength = `In ${officialGameName}: `.length;
        const availableChars = MAX_IRC_MESSAGE_LENGTH - prefixLength - 3; // -3 for potential ellipsis

        let description = verifiedAnalysisResult; // Start with the verified/refined result

        // Clean up text patterns that look unnatural
        description = description
            // Remove any instances of quoted phrases
            .replace(/["']([^"']{1,20})["']/g, '$1')
            // Remove common intro phrases
            .replace(/This (screenshot|image) (shows|depicts|is from) /gi, '')
            .replace(/^Based on the search results[:,]?\s*/i, '')
            .replace(/^According to [^:]+:\s*/i, '')
            .replace(/^Okay, here's the analysis:\s*/i, '')
            .replace(/In this (scene|screenshot|image|frame)/gi, '')
            .replace(/The (screenshot|image) (shows|depicts) a scene from /gi, '')
            .replace(/We can see /gi, '')
            .replace(/I can see /gi, '')
            // Remove inline citations and sources sections
            .replace(/\s*\[(?:\d+|citation needed)\]\s*/gi, ' ')
            .replace(/\s*\(\d+\)\s*/g, ' ')
            .replace(/Sources?:[\s\S]*$/i, '')
            // Fix any double spaces that might have been created
            .replace(/\s{2,}/g, ' ')
            .trim();
        
        // Also apply markdown removal
        description = removeMarkdownAsterisks(description);

        // Handle length: try summarization first, then smart truncate as fallback
        if (description.length > availableChars) {
            logger.info(`Verified analysis too long (${description.length} > ${availableChars}). Attempting summarization.`);
            const summary = await summarizeText(description, availableChars);
            if (summary?.trim()) {
                description = summary.trim();
                logger.debug(`Analysis summarization successful (${description.length} chars)`);
            } else {
                logger.warn(`Analysis summarization failed, using smart truncation`);
                description = smartTruncate(description, availableChars);
            }
        }

        // --- Step 4: Send Final Message or Return Result ---
        let finalResponse = description;

        // Final safety check for IRC limits
        if (finalResponse.length > MAX_IRC_MESSAGE_LENGTH) {
            logger.warn(`Description exceeds IRC limit. Truncating to ${MAX_IRC_MESSAGE_LENGTH}.`);
            finalResponse = smartTruncate(finalResponse, MAX_IRC_MESSAGE_LENGTH);
        }

        if (sendToChat) {
            enqueueMessage(channel, finalResponse, { replyToId });
        }

        // Return the full description for use in help queries
        return description;

    } catch (error) {
        logger.error({ err: error }, 'Error in image analysis for !game command');
        if (sendToChat) {
            enqueueMessage(channel, `Sorry, there was an error analyzing the stream.`, { replyToId });
        }
        return null;
    }
}

/**
 * Gets additional game information and returns it as a string (or null).
 * @param {string} channelName - Channel without # prefix
 * @param {string} userName - Display name of requesting user
 * @param {string} gameName - Name of the game
 * @returns {Promise<string|null>} Interesting fact/overview or null
 */
async function getAdditionalGameInfo(channelName, userName, gameName) {
    try {
        if (!gameName || gameName === 'Unknown' || gameName === 'N/A') {
            logger.warn(`[${channelName}] Invalid game name for info request: "${gameName}"`);
            return null;
        }
        
        const contextManager = getContextManager();
        const llmContext = contextManager.getContextForLLM(channelName, userName, `general info request for ${gameName}`);
        const contextPrompt = buildContextPrompt(llmContext || {});
        const gameQuery = `Tell me something interesting or provide a brief overview about the game: "${gameName}"`;
        
        logger.info(`[${channelName}] Fetching additional info for game: "${gameName}"`);
        
        // First try with search
        let responseText = await generateSearchResponse(contextPrompt, gameQuery);
        logger.info(`[${channelName}] Search response for "${gameName}": ${responseText ? `"${responseText.substring(0, 100)}..."` : 'null/empty'}`);
        
        // If search fails, try standard response as fallback
        if (!responseText?.trim()) {
            logger.warn(`[${channelName}] Search response failed for "${gameName}", trying standard response`);
            responseText = await generateStandardResponse(contextPrompt, gameQuery);
            logger.info(`[${channelName}] Standard response for "${gameName}": ${responseText ? `"${responseText.substring(0, 100)}..."` : 'null/empty'}`);
        }
        
        if (!responseText?.trim()) {
            logger.error(`[${channelName}] Both search and standard responses failed for "${gameName}"`);
            return null;
        }
        
        // Clean up markdown
        let finalText = removeMarkdownAsterisks(responseText);

        // If too long, try LLM summarization first, then smart truncate as fallback
        if (finalText.length > SUMMARY_TARGET_LENGTH) {
            logger.debug(`[${channelName}] Response too long (${finalText.length}), attempting summarization`);
            const summary = await summarizeText(finalText, SUMMARY_TARGET_LENGTH);
            if (summary?.trim()) {
                finalText = summary.trim();
                logger.debug(`[${channelName}] Summarization successful (${finalText.length} chars)`);
            } else {
                logger.warn(`[${channelName}] Summarization failed, using smart truncation`);
                finalText = smartTruncate(finalText, SUMMARY_TARGET_LENGTH);
            }
        }

        logger.info(`[${channelName}] Final game info for "${gameName}": "${finalText.substring(0, 100)}..."`);
        return finalText.trim();
    } catch (error) {
        logger.error({ err: error, gameName }, `[${channelName}] Error getting additional game info for "${gameName}"`);
        return null;
    }
}

/**
 * Handles game info response using context data
 * @param {string} channel - Channel with # prefix
 * @param {string} channelName - Channel without # prefix
 * @param {string} userName - Display name of requesting user
 * @param {object} gameInfo - Game information from context
 */
async function handleGameInfoResponse(channel, channelName, userName, gameInfo, replyToId) {
    try {
        const gameName = (gameInfo?.gameName && gameInfo.gameName !== 'Unknown' && gameInfo.gameName !== 'N/A') ? gameInfo.gameName : null;

        if (!gameName) {
            enqueueMessage(channel, `I couldn't determine the current game.`, { replyToId });
            return;
        }

        // Get *only* the additional info
        const additionalInfo = await getAdditionalGameInfo(channelName, userName, gameName);

        if (additionalInfo) {
            // Clean up and handle length
            let responseText = removeMarkdownAsterisks(additionalInfo);

            if (responseText.length > MAX_IRC_MESSAGE_LENGTH) {
                logger.info(`Additional game info too long (${responseText.length}). Attempting summarization.`);
                const summary = await summarizeText(responseText, MAX_IRC_MESSAGE_LENGTH - 20);
                if (summary?.trim()) {
                    responseText = summary.trim();
                    logger.debug(`Summarization successful (${responseText.length} chars)`);
                } else {
                    logger.warn(`Summarization failed, using smart truncation`);
                    responseText = smartTruncate(responseText, MAX_IRC_MESSAGE_LENGTH);
                }
            }

            // Defensive: avoid sending meta thought/regurgitation if present
            const scrubbed = responseText.replace(/^(Thinking Process|Reasoning|Analysis)[:-].*$/i, '').trim();
            enqueueMessage(channel, scrubbed, { replyToId });
        } else {
            // If no additional info is found, provide the basic game info with a helpful message
            logger.warn(`[${channelName}] No additional info found for game: ${gameName}. Sending basic response.`);
            enqueueMessage(channel, `Currently playing ${gameName}. Try "!game [your question]" for specific help with the game.`, { replyToId });
        }
    } catch (error) {
        logger.error({ err: error }, 'Error handling game info response (concise version)');
        const gameName = gameInfo?.gameName || 'Unknown';
        enqueueMessage(channel, `Current game: ${gameName}`, { replyToId });
    }
}

/**
 * Handles specific gameplay help requests using search.
 * @param {string} channel - Channel with # prefix
 * @param {string} channelName - Channel without # prefix
 * @param {string} userName - Display name of requesting user
 * @param {string} helpQuery - The specific question the user asked
 * @param {string|null} replyToId - The ID of the message to reply to
 * @param {string|null} imageAnalysisContext - Optional image analysis result to include as context
 */
async function handleGameHelpRequest(channel, channelName, userName, helpQuery, replyToId = null, imageAnalysisContext = null) {
    logger.info(`[${channelName}] Handling game help request from ${userName}: "${helpQuery}"`);
    try {
        // 1. Get Current Game Name
        const gameInfo = await getCurrentGameInfo(channelName);
        const gameName = (gameInfo?.gameName && gameInfo.gameName !== 'Unknown' && gameInfo.gameName !== 'N/A') ? gameInfo.gameName : null;

        if (!gameName) {
            // Softer, user-friendly guidance that acknowledges transient fetch issues
            enqueueMessage(channel, `I'm fetching the current game info. Please try "!game ${helpQuery}" again in a few seconds, or include the game name like "!search <game> ${helpQuery}".`, { replyToId });
            return;
        }

        // 2. Get Context & Formulate Search Query
        const contextManager = getContextManager();
        const llmContext = contextManager.getContextForLLM(channelName, userName, helpQuery);
        const contextPrompt = buildContextPrompt(llmContext || {});

        // Formulate a search-triggering query that requires web search
        let helpSearchQuery;
        if (imageAnalysisContext) {
            // Include screenshot context when available
            helpSearchQuery = `Screenshot shows: "${imageAnalysisContext}"\n\nUse web search to answer: "${helpQuery}" for "${gameName}" based on what's shown in the screenshot. Give a direct, factual tip in ≤ 320 chars. Plain text. No citations, no markdown.`;
        } else {
            // Original query when no image context
            helpSearchQuery = `Use web search to answer: "${helpQuery}" for "${gameName}". Give a direct, factual tip in ≤ 320 chars. Plain text. No citations, no markdown.`;
        }

        // 3. Call Search-Grounded LLM with a retry mechanism for robustness
        let searchResultText = null;
        const maxRetries = 3;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            searchResultText = await generateSearchResponse(contextPrompt, helpSearchQuery);
            if (searchResultText && searchResultText.trim().length > 0) {
                logger.info(`[${channelName}] Search successful on attempt ${attempt + 1}.`);
                break;
            }
            const delayMs = 1000;
            logger.warn(`[${channelName}] Search attempt ${attempt + 1} of ${maxRetries} returned no result. Retrying in ${delayMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        if (!searchResultText || searchResultText.trim().length === 0) {
            logger.warn(`[${channelName}] Help search returned no results for query: "${helpQuery}" in game "${gameName}" after ${maxRetries} attempts.`);
            enqueueMessage(channel, `Sorry, I couldn't find specific help for "${helpQuery}" in ${gameName} right now.`, { replyToId });
            return;
        }

        // 4. Format and Send Response
        let finalReplyText = removeMarkdownAsterisks(searchResultText)
            .replace(/^(Thinking Process|Reasoning|Analysis)[::-].*$/i, '')
            .replace(/^Based on the search results[:,]?\s*/i, '')
            .replace(/^According to [^:]+:\s*/i, '')
            .replace(/\s*\[(?:\d+|citation needed)\]\s*/gi, ' ')
            .replace(/\s*\(\d+\)\s*/g, ' ')
            .replace(/Sources?:[\s\S]*$/i, '')
            .trim();

        // Handle length: try summarization first, smart truncate as fallback
        if (finalReplyText.length > MAX_IRC_MESSAGE_LENGTH) {
            logger.info(`[${channelName}] Help response too long (${finalReplyText.length} chars). Attempting summarization.`);
            const summary = await summarizeText(finalReplyText, MAX_IRC_MESSAGE_LENGTH - 20);
            if (summary?.trim()) {
                finalReplyText = removeMarkdownAsterisks(summary.trim());
                logger.debug(`[${channelName}] Summarization successful (${finalReplyText.length} chars)`);
            } else {
                logger.warn(`[${channelName}] Summarization failed, using smart truncation`);
                finalReplyText = smartTruncate(finalReplyText, MAX_IRC_MESSAGE_LENGTH);
            }
        }

        enqueueMessage(channel, finalReplyText, { replyToId });

    } catch (error) {
        logger.error({ err: error, channel: channelName, user: userName, helpQuery }, `Error processing game help request.`);
        enqueueMessage(channel, `Sorry, an error occurred while searching for help with "${helpQuery}".`, { replyToId });
    }
}

export default gameHandler;