// src/components/commands/handlers/game.js
import logger from '../../../lib/logger.js';
// Need context manager to get the current game
import { getContextManager } from '../../context/contextManager.js';
// Need LLM functions for search and summarization, and context builder
import { buildContextPrompt, generateSearchResponse, generateStandardResponse, summarizeText } from '../../llm/geminiClient.js';
// Need image analysis functions
import { fetchStreamThumbnail, getCurrentGameInfo } from '../../twitch/streamImageCapture.js';
import { analyzeImage } from '../../llm/geminiImageClient.js';
// Need summarizer for image analysis results

// Need message queue
import { enqueueMessage } from '../../../lib/ircSender.js';
// Import markdown removal utility
import { removeMarkdownAsterisks } from '../../llm/llmUtils.js';

const MAX_IRC_MESSAGE_LENGTH = 450;
const SUMMARY_TARGET_LENGTH = 300; // Shortened to allow for formatting and mentions



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
            if (analysisRequested) {
                await handleImageAnalysis(channel, channelName, userName);
                // If both analysis and help are requested, add a small delay to avoid message overlap
                if (helpRequested) await new Promise(resolve => setTimeout(resolve, 1200));
            }

            // --- Execute Help Search if requested ---
            if (helpRequested) {
                await handleGameHelpRequest(channel, channelName, userName, helpQuery);
                return;
            }

            // --- Fallback: Handle !game with no analysis or help query ---
            if (!analysisRequested && !helpRequested) {
                const gameInfo = await getCurrentGameInfo(channelName);
                if (gameInfo && gameInfo.gameName !== 'Unknown' && gameInfo.gameName !== 'N/A') {
                    await handleGameInfoResponse(channel, channelName, userName, gameInfo);
                } else {
                    logger.info(`[${channelName}] No current game set in context for basic !game command.`);
                    enqueueMessage(channel, `@${userName}, I don't see a game set for the stream right now.`);
                }
                return;
            }

        } catch (error) {
            logger.error({ err: error, command: 'game', analysisRequested, helpRequested }, `Error executing !game command flow.`);
            enqueueMessage(channel, `@${userName}, sorry, an error occurred while processing the !game command.`);
        }
    },
};

/**
 * Handles image analysis for the game command with balanced text cleanup
 * @param {string} channel - Channel with # prefix
 * @param {string} channelName - Channel without # prefix
 * @param {string} userName - Display name of requesting user
 */
async function handleImageAnalysis(channel, channelName, userName) {
    try {
        // Removed confirmation message to reduce chat verbosity
        // Get the official game info from the API/context FIRST
        const gameInfo = await getCurrentGameInfo(channelName);
        const officialGameName = (gameInfo?.gameName && gameInfo.gameName !== 'Unknown' && gameInfo.gameName !== 'N/A') ? gameInfo.gameName : null;
        
        if (!officialGameName) {
            enqueueMessage(channel, `@${userName}, couldn't determine the current game. The channel might not be streaming a game.`);
            return;
        }
        
        // Fetch the stream thumbnail
        const thumbnailBuffer = await fetchStreamThumbnail(channelName);
        
        if (!thumbnailBuffer) {
            enqueueMessage(channel, `@${userName}, couldn't fetch the stream thumbnail. The channel might be offline.`);
            return;
        }
        
        // --- Step 1: Initial Image Analysis ---
        // Prompt focuses purely on description now
        const initialAnalysisPrompt = `Analyze this screenshot from the game "${officialGameName}". Describe what's happening, player actions, and notable UI elements. Focus only on description.`;

        // Analyze the image with Gemini
        const initialAnalysisResult = await analyzeImage(thumbnailBuffer, initialAnalysisPrompt);

        if (!initialAnalysisResult || initialAnalysisResult.trim().length === 0) {
            enqueueMessage(channel, `@${userName}, AI couldn't analyze the ${officialGameName} gameplay initially.`);
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
            const verificationQuery = `Your task is to produce a concise, fact-checked description of the *in-game scene* shown in a video game screenshot from "${officialGameName}". You are given an initial analysis generated directly from the screenshot.

Initial analysis (describes visuals in the CURRENT screenshot):
"${initialAnalysisResult}"

Refinement Instructions:
1.  **Focus on In-Game Elements:** Prioritize describing characters, environment, items, actions, and UI elements belonging *to the game itself*.
2.  **Ignore Stream Overlays:** Explicitly **ignore and do not mention** common stream overlay elements such as clocks, timestamps, webcam borders, donation alerts, subscriber goals, chat boxes overlaid on the game, or mouse cursors, unless the initial analysis *mistakenly* identifies them as part of the game.
3. **Correct ONLY Clear Factual Errors:** If search *proves* a specific claim about an *in-game element* in the 'Initial analysis' is factually impossible within "${officialGameName}", correct *only that specific error* concisely.
4. **Do NOT Add External Information:** Do *not* introduce characters, locations, items, or events based on search results if they were *not* mentioned as *in-game elements* in the 'Initial analysis'.
5. **Output the Refined Description ONLY:** Your entire response MUST be the refined textual description of the *in-game scene*. Do NOT output commentary *about* the analysis (e.g., do not say "The analysis is accurate").

Validated/Refined Analysis of the Screenshot:`; // Let the LLM complete this.

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
        const prefixLength = `@${userName}, In ${officialGameName}: `.length;
        const availableChars = MAX_IRC_MESSAGE_LENGTH - prefixLength - 3; // -3 for potential ellipsis

        let description = verifiedAnalysisResult; // Start with the verified/refined result

        // Clean up text patterns that look unnatural
        description = description
            // Remove any instances of quoted phrases
            .replace(/["']([^"']{1,20})["']/g, '$1')
            // Remove common intro phrases
            .replace(/This (screenshot|image) (shows|depicts|is from) /gi, '')
            .replace(/^Based on the search results[:,]?\s*/i, '')
            .replace(/^Okay, here's the analysis:\s*/i, '')
            .replace(/In this (scene|screenshot|image|frame)/gi, '')
            .replace(/The (screenshot|image) (shows|depicts) a scene from /gi, '')
            .replace(/We can see /gi, '')
            .replace(/I can see /gi, '')
            // Fix any double spaces that might have been created
            .replace(/\s{2,}/g, ' ')
            .trim();
        
        // Also apply markdown removal
        description = removeMarkdownAsterisks(description);

        // Apply summarization/truncation if still too long
        if (description.length > availableChars) {
            logger.info(`Verified analysis too long (${description.length} > ${availableChars}). Summarizing/Truncating.`);
            // Try summarizing first
            const summary = await summarizeText(description, availableChars - 10); // Target slightly shorter
            if (summary && summary.trim().length > 0) {
                 description = removeMarkdownAsterisks(summary.trim()); // Apply markdown removal to summary too
            } else {
                // Fallback to truncation if summary fails or is empty
                logger.warn(`Summarization failed for verified analysis. Truncating.`);
                const sentenceEndRegex = /[.!?][^.!?]*$/;
                 // Try to find sentence endings
                const matchSentenceEnd = description.substring(0, availableChars).match(sentenceEndRegex);

                if (matchSentenceEnd) {
                    const endIndex = availableChars - matchSentenceEnd[0].length + 1;
                    description = description.substring(0, endIndex > 0 ? endIndex : 0);
                } else {
                    // Try to find a comma or other natural break
                    const commaBreakRegex = /,[^,]*$/;
                    const matchComma = description.substring(0, availableChars).match(commaBreakRegex);

                    if (matchComma) {
                        const endIndex = availableChars - matchComma[0].length + 1;
                        description = description.substring(0, endIndex > 0 ? endIndex : 0);
                    } else {
                        // If no natural break, try to break at a space
                        const lastSpaceIndex = description.substring(0, availableChars).lastIndexOf(' ');
                        if (lastSpaceIndex > availableChars * 0.8) {
                            description = description.substring(0, lastSpaceIndex);
                        } else {
                            // Last resort: hard cut
                            description = description.substring(0, availableChars > 0 ? availableChars : 0);
                        }
                    }
                }
                 description += '...'; // Add ellipsis for truncation
            }
        }

        // --- Step 4: Send Final Message ---
        const gameResponse = `@${userName}: ${description}`;

        // Final length check for IRC limits (shouldn't be needed with above logic, but safety first)
        if (gameResponse.length > MAX_IRC_MESSAGE_LENGTH) {
            const truncated = gameResponse.substring(0, MAX_IRC_MESSAGE_LENGTH - 3) + '...';
            enqueueMessage(channel, truncated);
        } else {
            enqueueMessage(channel, gameResponse);
        }
        
    } catch (error) {
        logger.error({ err: error }, 'Error in image analysis for !game command');
        enqueueMessage(channel, `@${userName}, sorry, there was an error analyzing the stream.`);
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
        
        let finalText = responseText;
        if (finalText.length > SUMMARY_TARGET_LENGTH) {
            logger.debug(`[${channelName}] Response too long (${finalText.length}), summarizing`);
            const summary = await summarizeText(finalText, SUMMARY_TARGET_LENGTH);
            finalText = summary?.trim() ? summary : finalText.substring(0, SUMMARY_TARGET_LENGTH - 3) + '...';
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
async function handleGameInfoResponse(channel, channelName, userName, gameInfo) {
    try {
        const gameName = (gameInfo?.gameName && gameInfo.gameName !== 'Unknown' && gameInfo.gameName !== 'N/A') ? gameInfo.gameName : null;

        if (!gameName) {
            enqueueMessage(channel, `@${userName}, I couldn't determine the current game.`);
            return;
        }

        // Get *only* the additional info
        const additionalInfo = await getAdditionalGameInfo(channelName, userName, gameName);

        if (additionalInfo) {
            // We have additional info, format the response *just* with that
            let responseText = additionalInfo;
            const prefix = `@${userName}, `;
            const maxTextLength = MAX_IRC_MESSAGE_LENGTH - prefix.length - 3;

            // Truncate *only the additional info text* if necessary
            if (responseText.length > maxTextLength) {
                logger.info(`Additional game info too long (${responseText.length} > ${maxTextLength}). Truncating.`);
                responseText = removeMarkdownAsterisks(responseText.substring(0, maxTextLength < 0 ? 0 : maxTextLength) + '...');
            } else {
                responseText = removeMarkdownAsterisks(responseText);
            }

            const finalMessage = prefix + responseText;
            enqueueMessage(channel, finalMessage);
        } else {
            // If no additional info is found, provide the basic game info with a helpful message
            logger.warn(`[${channelName}] No additional info found for game: ${gameName}. Sending basic response.`);
            enqueueMessage(channel, `@${userName}, currently playing ${gameName}. Try "!game [your question]" for specific help with the game.`);
        }
    } catch (error) {
        logger.error({ err: error }, 'Error handling game info response (concise version)');
        const gameName = gameInfo?.gameName || 'Unknown';
        enqueueMessage(channel, `@${userName}, Current game: ${gameName}`);
    }
}

/**
 * Handles specific gameplay help requests using search.
 * @param {string} channel - Channel with # prefix
 * @param {string} channelName - Channel without # prefix
 * @param {string} userName - Display name of requesting user
 * @param {string} helpQuery - The specific question the user asked
 */
async function handleGameHelpRequest(channel, channelName, userName, helpQuery) {
    logger.info(`[${channelName}] Handling game help request from ${userName}: "${helpQuery}"`);
    try {
        // 1. Get Current Game Name
        const gameInfo = await getCurrentGameInfo(channelName);
        const gameName = (gameInfo?.gameName && gameInfo.gameName !== 'Unknown' && gameInfo.gameName !== 'N/A') ? gameInfo.gameName : null;

        if (!gameName) {
            enqueueMessage(channel, `@${userName}, I couldn't determine the current game to search for help. Please ensure the stream category is set.`);
            return;
        }

        // 2. Get Context & Formulate Search Query
        const contextManager = getContextManager();
        const llmContext = contextManager.getContextForLLM(channelName, userName, helpQuery);
        const contextPrompt = buildContextPrompt(llmContext || {});
        
        // Formulate a query targeting walkthroughs/help
        const helpSearchQuery = `Find the best and most effective strategy or walkthrough information for the game "${gameName}" regarding this specific problem: "${helpQuery}"`;

        // 3. Call Search-Grounded LLM
        const searchResultText = await generateSearchResponse(contextPrompt, helpSearchQuery);

        if (!searchResultText || searchResultText.trim().length === 0) {
            logger.warn(`[${channelName}] Help search returned no results for query: "${helpQuery}" in game "${gameName}".`);
            enqueueMessage(channel, `@${userName}, Sorry, I couldn't find specific help for "${helpQuery}" in ${gameName} right now.`);
            return;
        }

        // 4. Format and Send Response
        let replyPrefix = `@${userName}: `;
        let finalReplyText = removeMarkdownAsterisks(searchResultText);

        // Check length and Summarize/Truncate if needed
        if ((replyPrefix.length + finalReplyText.length) > MAX_IRC_MESSAGE_LENGTH) {
            logger.info(`[${channelName}] Help response too long (${finalReplyText.length} chars). Attempting summarization.`);
            const summary = await summarizeText(finalReplyText, SUMMARY_TARGET_LENGTH);
            if (summary?.trim()) {
                finalReplyText = removeMarkdownAsterisks(summary);
                logger.info(`[${channelName}] Help response summarization successful (${finalReplyText.length} chars).`);
            } else {
                logger.warn(`[${channelName}] Summarization failed for help response. Falling back to truncation.`);
                const availableLength = MAX_IRC_MESSAGE_LENGTH - replyPrefix.length - 3;
                finalReplyText = finalReplyText.substring(0, availableLength < 0 ? 0 : availableLength) + '...';
            }
        }

        // Final length check
        let finalMessage = replyPrefix + finalReplyText;
        if (finalMessage.length > MAX_IRC_MESSAGE_LENGTH) {
             logger.warn(`[${channelName}] Final help reply too long (${finalMessage.length} chars). Truncating sharply.`);
             finalMessage = finalMessage.substring(0, MAX_IRC_MESSAGE_LENGTH - 3) + '...';
        }
        
        enqueueMessage(channel, finalMessage);

    } catch (error) {
        logger.error({ err: error, channel: channelName, user: userName, helpQuery }, `Error processing game help request.`);
        enqueueMessage(channel, `@${userName}, Sorry, an error occurred while searching for help with "${helpQuery}".`);
    }
}

export default gameHandler;