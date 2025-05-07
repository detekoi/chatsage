// src/components/commands/handlers/game.js
import logger from '../../../lib/logger.js';
// Need context manager to get the current game
import { getContextManager } from '../../context/contextManager.js';
// Need LLM functions for search and summarization, and context builder
import { buildContextPrompt, generateSearchResponse, summarizeText } from '../../llm/geminiClient.js';
// Need image analysis functions
import { fetchStreamThumbnail, getCurrentGameInfo } from '../../twitch/streamImageCapture.js';
import { analyzeImage } from '../../llm/geminiImageClient.js';
// Need summarizer for image analysis results
import { triggerSummarizationIfNeeded } from '../../context/summarizer.js';
// Need message queue
import { enqueueMessage } from '../../../lib/ircSender.js';
// Import markdown removal utility
import { removeMarkdownAsterisks } from '../../llm/llmUtils.js';

const MAX_IRC_MESSAGE_LENGTH = 450;
const SUMMARY_TARGET_LENGTH = 300; // Shortened to allow for formatting and mentions

/**
 * Creates a summarization prompt specifically for AI image analysis results
 * @param {string|object} analysisResult - The image analysis result to summarize
 * @returns {string} Formatted prompt for summarization
 */
function buildImageAnalysisSummaryPrompt(analysisResult) {
    let textToSummarize;
    
    if (typeof analysisResult === 'string') {
        textToSummarize = analysisResult;
    } else {
        // Format object into text
        const gameName = analysisResult.game || 'Unknown';
        const activity = analysisResult.activity || '';
        const uiElements = analysisResult.ui_elements && analysisResult.ui_elements.length > 0
            ? analysisResult.ui_elements.join(', ')
            : '';
            
        textToSummarize = `Game: ${gameName}\nActivity: ${activity}\nUI Elements: ${uiElements}`;
    }
    
    return `Summarize the following AI image analysis of a video game stream.
Keep only the most important details and ensure your summary is under 200 characters.
Format as: Game name | Activity description | Key UI elements (if relevant)

--- START OF ANALYSIS ---
${textToSummarize}
--- END OF ANALYSIS ---

Concise summary:`;
}

/**
 * Custom summarization for image analysis results
 * @param {string|object} analysisResult - The image analysis result to summarize
 * @returns {Promise<string>} Summarized text
 */
async function summarizeImageAnalysis(analysisResult) {
    try {
        // If it's already a string and short enough, just return it
        if (typeof analysisResult === 'string' && analysisResult.length <= SUMMARY_TARGET_LENGTH) {
            return analysisResult;
        }
        
        // Create messages array mimicking chat history format expected by summarizer
        const mockMessages = [{
            username: 'Image Analysis',
            message: typeof analysisResult === 'string' 
                ? analysisResult 
                : JSON.stringify(analysisResult, null, 2)
        }];
        
        // Use the existing summarization function
        const summary = await triggerSummarizationIfNeeded('imageAnalysis', mockMessages);
        
        if (summary) {
            return summary;
        }
        
        // Fallback: Simple truncation if summarization fails
        if (typeof analysisResult === 'string') {
            return analysisResult.substring(0, SUMMARY_TARGET_LENGTH);
        } else {
            // Basic object formatting with truncation
            const gameName = analysisResult.game || 'Unknown';
            const activity = analysisResult.activity 
                ? analysisResult.activity.substring(0, 150) 
                : '';
            
            return `${gameName} | ${activity}`;
        }
    } catch (error) {
        logger.error({ err: error }, 'Error summarizing image analysis');
        // Return a simplified version on error
        if (typeof analysisResult === 'string') {
            return analysisResult.substring(0, SUMMARY_TARGET_LENGTH);
        } else {
            return analysisResult.game || 'Unknown game';
        }
    }
}

/**
 * Determines if argument indicates an image analysis is requested
 * @param {string[]} args - Command arguments
 * @returns {boolean} True if image analysis is requested
 */
function shouldUseImageAnalysis(args) {
    if (!args || args.length === 0) return false;
    
    const analysisTerms = ['analyze', 'image', 'ai', 'vision', 'detect', 'looking', 'sees', 'screen'];
    
    // Check if any argument contains analysis terms
    return args.some(arg => 
        analysisTerms.some(term => arg.toLowerCase().includes(term))
    );
}

/**
 * Handler for the !game command.
 * Retrieves the current game from context and provides researched info via LLM search.
 * Can also analyze stream thumbnails using image recognition when requested.
 */
const gameHandler = {
    name: 'game',
    description: 'Provides information about the game currently being played. Add "analyze" to use AI image recognition on the stream.',
    usage: '!game [analyze]',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelName = channel.substring(1);
        const userName = user['display-name'] || user.username;
        const useImageAnalysis = shouldUseImageAnalysis(args);
        
        logger.info({
            command: 'game',
            channel: channelName,
            user: userName,
            useImageAnalysis
        }, `Executing !game command`);

        try {
            // Try the image analysis path if requested
            if (useImageAnalysis) {
                await handleImageAnalysis(channel, channelName, userName);
                return;
            }
            
            // Get game info from context (our most reliable source)
            const gameInfo = await getCurrentGameInfo(channelName);
            
            if (gameInfo && gameInfo.gameName !== 'Unknown') {
                // We have game info from context, provide it
                await handleGameInfoResponse(channel, channelName, userName, gameInfo);
                return;
            }
            
            // If we don't have game info, inform the user
            logger.info(`[${channelName}] No current game set in context for !game command.`);
            enqueueMessage(channel, `@${userName}, I don't see a game set for the stream right now.`);
            
        } catch (error) {
            logger.error({ err: error, command: 'game' }, `Error executing !game command.`);
            enqueueMessage(channel, `@${userName}, sorry, an error occurred while fetching game info.`);
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
        const gameResponse = `@${userName}, In ${officialGameName}: ${description}`;

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
 * Handles game info response using context data
 * @param {string} channel - Channel with # prefix
 * @param {string} channelName - Channel without # prefix
 * @param {string} userName - Display name of requesting user
 * @param {object} gameInfo - Game information from context
 */
async function handleGameInfoResponse(channel, channelName, userName, gameInfo) {
    try {
        const gameName = gameInfo.gameName;
        
        // Basic response with context data
        let basicResponse = `@${userName}, Current game: ${gameName}`;
        
        // Add additional info if available
        if (gameInfo.streamTitle && gameInfo.streamTitle !== 'Unknown') {
            basicResponse += ` | Stream title: ${gameInfo.streamTitle}`;
        }
        
        if (gameInfo.viewerCount) {
            basicResponse += ` | Viewers: ${gameInfo.viewerCount}`;
        }
        
        if (basicResponse.length <= MAX_IRC_MESSAGE_LENGTH) {
            enqueueMessage(channel, basicResponse);
        } else {
            // Truncate if too long
            const truncated = basicResponse.substring(0, MAX_IRC_MESSAGE_LENGTH - 3) + '...';
            enqueueMessage(channel, truncated);
        }
        
        // Get additional game info in background
        getAdditionalGameInfo(channel, channelName, userName, gameName);
        
    } catch (error) {
        logger.error({ err: error }, 'Error handling game info response');
        
        // Fallback to simple response if error in formatting
        const gameName = gameInfo?.gameName || 'Unknown';
        enqueueMessage(channel, `@${userName}, Current game: ${gameName}`);
    }
}

/**
 * Gets additional game information and sends a follow-up message
 * @param {string} channel - Channel with # prefix
 * @param {string} channelName - Channel without # prefix
 * @param {string} userName - Display name of requesting user
 * @param {string} gameName - Name of the game
 */
async function getAdditionalGameInfo(channel, channelName, userName, gameName) {
    try {
        // If game name is unknown or missing, don't proceed
        if (!gameName || gameName === 'Unknown' || gameName === 'N/A') {
            return;
        }
        
        // Build context prompt
        const contextManager = getContextManager();
        const llmContext = contextManager.getContextForLLM(channelName, userName, "game info request");
        const contextPrompt = buildContextPrompt(llmContext || {});
        
        // Formulate query
        const gameQuery = `Tell me something interesting or provide a brief overview about the game: "${gameName}"`;
        
        // Get response from LLM
        const responseText = await generateSearchResponse(contextPrompt, gameQuery);
        
        if (!responseText?.trim()) {
            return; // No need to send a follow-up if we have no additional info
        }
        
        // Format and check length
        let finalText = responseText;
        
        if (finalText.length > SUMMARY_TARGET_LENGTH) {
            const summary = await summarizeText(finalText, SUMMARY_TARGET_LENGTH);
            finalText = summary?.trim() ? summary : finalText.substring(0, SUMMARY_TARGET_LENGTH - 3) + '...';
        }
        
        // Formulate follow-up message (no @ mention to avoid notification spam)
        const followUp = `More about ${gameName}: ${finalText}`;
        
        if (followUp.length <= MAX_IRC_MESSAGE_LENGTH) {
            enqueueMessage(channel, followUp);
        } else {
            const truncated = followUp.substring(0, MAX_IRC_MESSAGE_LENGTH - 3) + '...';
            enqueueMessage(channel, truncated);
        }
        
    } catch (error) {
        logger.error({ err: error }, 'Error getting additional game info');
        // Silently fail - no need to send error message for the follow-up
    }
}

export default gameHandler;