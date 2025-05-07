// src/components/commands/handlers/game.js
import logger from '../../../lib/logger.js';
// Need context manager to get the current game
import { getContextManager } from '../../context/contextManager.js';
// Need LLM functions for search and summarization, and context builder
import { buildContextPrompt, generateSearchResponse, summarizeText } from '../../llm/geminiClient.js';
// Need image analysis functions
import { fetchStreamThumbnail, getCurrentGameInfo } from '../../twitch/streamImageCapture.js';
import { analyzeGameStream, analyzeImage } from '../../llm/geminiImageClient.js';
// Need summarizer for image analysis results
import { triggerSummarizationIfNeeded } from '../../context/summarizer.js';
// Need message queue
import { enqueueMessage } from '../../../lib/ircSender.js';

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
 * Handles image analysis for the game command with direct summarization
 * @param {string} channel - Channel with # prefix
 * @param {string} channelName - Channel without # prefix
 * @param {string} userName - Display name of requesting user
 */
async function handleImageAnalysis(channel, channelName, userName) {
    try {
        // Inform user we're processing
        enqueueMessage(channel, `@${userName}, analyzing the stream using AI image recognition...`);
        
        // Get the official game info from the API/context FIRST
        const gameInfo = await getCurrentGameInfo(channelName);
        const officialGameName = gameInfo?.gameName !== 'Unknown' ? gameInfo.gameName : null;
        
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
        
        // Modify the prompt to focus on scene analysis AND make it concise from the start
        const analysisPrompt = `This is a screenshot from the game "${officialGameName}". 
                               Analyze what's happening in the scene, what the player is doing, 
                               and any notable UI elements visible.
                               IMPORTANT: Keep your response very concise (max 200 characters).
                               Just describe what you see in 1-3 short sentences.`;
        
        // Analyze the image with Gemini - directly asking for concise results
        const analysisResult = await analyzeImage(thumbnailBuffer, analysisPrompt);
        
        if (!analysisResult) {
            enqueueMessage(channel, `@${userName}, AI couldn't analyze the ${officialGameName} gameplay.`);
            return;
        }
        
        // If result is still too long, manually trim it to ensure it fits
        let conciseDescription = analysisResult;
        if (conciseDescription.length > 350) {
            // Find a good cutoff point (sentence ending)
            const sentenceEndMatch = conciseDescription.substring(0, 350).match(/[.!?][^.!?]*$/);
            if (sentenceEndMatch) {
                const endIndex = 350 - sentenceEndMatch[0].length + 1; // +1 to include the punctuation
                conciseDescription = conciseDescription.substring(0, endIndex);
            } else {
                // If no sentence ending found, just cut at 350
                conciseDescription = conciseDescription.substring(0, 350);
            }
        }
        
        // Format the final response
        const gameResponse = `@${userName}, In ${officialGameName}: ${conciseDescription}`;
        
        // Final length check for IRC limits
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