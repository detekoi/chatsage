// Import using the default import method as suggested by the error
import GoogleGenerativeAI_pkg from "@google/genai";
// Destructure the necessary components from the imported package object
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = GoogleGenerativeAI_pkg;

import logger from '../../lib/logger.js';
import config from '../../config/index.js'; // Assuming config has gemini.apiKey and gemini.modelId

let genAI = null;
let generativeModel = null;

/**
 * Initializes the GoogleGenerativeAI client and the specific model.
 * @param {object} geminiConfig - Gemini configuration containing apiKey and modelId.
 */
function initializeGeminiClient(geminiConfig) {
    if (genAI) {
        logger.warn('Gemini client already initialized.');
        return;
    }

    if (!geminiConfig || !geminiConfig.apiKey || !geminiConfig.modelId) {
        throw new Error('Missing required Gemini configuration (apiKey, modelId).');
    }

    try {
        logger.info(`Initializing GoogleGenerativeAI with model: ${geminiConfig.modelId}`);
        // Now use the destructured GoogleGenerativeAI class
        genAI = new GoogleGenerativeAI(geminiConfig.apiKey);
        generativeModel = genAI.getGenerativeModel({
            model: geminiConfig.modelId,
            safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
            ],
             generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 250,
            }
        });
        logger.info('Gemini client and model initialized successfully.');
    } catch (error) {
        logger.fatal({ err: error }, 'Failed to initialize GoogleGenerativeAI client.');
        genAI = null; // Reset on failure
        generativeModel = null;
        throw error; // Propagate error to stop application startup
    }
}

/**
 * Gets the initialized GoogleGenerativeAI instance. (Less commonly needed than the model)
 * @returns {GoogleGenerativeAI} The GoogleGenerativeAI instance.
 * @throws {Error} If the client has not been initialized.
 */
function getGenAIInstance() {
     if (!genAI) {
        throw new Error('Gemini client (GenAI) has not been initialized.');
    }
    return genAI;
}
/**
 * Gets the initialized generative model instance.
 * @returns {GenerativeModel} The initialized generative model instance.
 * @throws {Error} If the client/model has not been initialized.
 */
function getGeminiClient() {
    if (!generativeModel) {
        throw new Error('Gemini client (Model) has not been initialized. Call initializeGeminiClient first.');
    }
    return generativeModel;
}


/**
 * Constructs the prompt string based on the provided context components.
 * @param {object} context - Context object.
 * @param {string} context.streamGame - Current game name.
 * @param {string} context.streamTitle - Current stream title.
 * @param {string} context.streamTags - Current stream tags (comma-separated).
 * @param {string} context.chatSummary - Summary of older chat messages.
 * @param {string} context.recentChatHistory - String representation of recent messages.
 * @param {string} context.username - Username of the user who sent the current message.
 * @param {string} context.currentMessage - The content of the current message.
 * @returns {string} The fully formatted prompt string.
 */
function buildPrompt(context) {
    const game = context.streamGame || "N/A";
    const title = context.streamTitle || "N/A";
    const tags = context.streamTags || "N/A";
    const summary = context.chatSummary || "No summary available.";
    const history = context.recentChatHistory || "No recent messages.";

    if (!context.username || context.currentMessage === undefined || context.currentMessage === null) {
        logger.error({ providedContext: context }, 'Cannot build prompt: Missing username or currentMessage.');
        throw new Error('Missing required context (username, currentMessage) for building prompt.');
    }

    return `You are StreamSage, a helpful AI assistant in a Twitch chat. Be concise and engaging like a chatbot.

**Current Stream Information:**
Game: ${game}
Title: ${title}
Tags: ${tags}

**Chat Summary:**
${summary}

**Recent Messages:**
${history}

**New message from ${context.username}:** ${context.currentMessage}

StreamSage Response:`;
}


/**
 * Generates a response using the Gemini API based on provided context.
 * @param {object} context - Context object (see buildPrompt for structure).
 * @returns {Promise<string | null>} Resolves with the generated text response, or null if generation failed or was blocked.
 */
async function generateResponse(context) {
    const model = getGeminiClient();
    let promptText;

    try {
        promptText = buildPrompt(context);
        logger.debug({ prompt: promptText }, 'Generated prompt for Gemini API');
    } catch (error) {
         logger.error({ err: error }, 'Failed to build prompt.');
         return null;
    }

    try {
        const result = await model.generateContent(promptText);
        const response = result.response;

        if (response.promptFeedback?.blockReason) {
            logger.warn({
                blockReason: response.promptFeedback.blockReason,
                safetyRatings: response.promptFeedback.safetyRatings,
                prompt: "[prompt omitted]" // Avoid logging potentially problematic prompt verbatim
            }, 'Gemini request blocked due to prompt safety settings.');
            return null;
        }

        if (!response.candidates || response.candidates.length === 0 || !response.candidates[0].content) {
             logger.warn({ response }, 'Gemini response missing candidates or content.');
             return null;
        }

        const candidate = response.candidates[0];
        if ( candidate.finishReason && candidate.finishReason !== 'STOP' && candidate.finishReason !== 'MAX_TOKENS') {
             logger.warn({
                finishReason: candidate.finishReason,
                safetyRatings: candidate.safetyRatings,
             }, `Gemini generation finished unexpectedly: ${candidate.finishReason}`);
             if (candidate.finishReason === 'SAFETY') {
                 logger.warn('Gemini response content blocked due to safety settings.');
             }
             return null;
        }

        // Check for content parts before joining
        if (!candidate.content.parts || candidate.content.parts.length === 0) {
            logger.warn({ candidate }, 'Gemini response candidate missing content parts.');
            return null;
        }

        const text = candidate.content.parts.map(part => part.text).join('');
        logger.info({ responseLength: text.length, finishReason: candidate.finishReason || 'N/A' }, 'Successfully generated response from Gemini.');
        return text.trim();

    } catch (error) {
        logger.error({ err: error, prompt: "[prompt omitted]" }, 'Error during Gemini API call');

        if (error.message && error.message.includes('429')) {
             logger.warn('Gemini API rate limit likely exceeded. Consider backoff/retry.');
        } else if (error.message && (error.message.includes('500') || error.message.includes('503'))) {
             logger.warn('Gemini API server error encountered. Consider backoff/retry.');
        } else if (error.message?.includes('API key not valid')) { // More specific error check
            logger.error('Gemini API key is not valid. Please check GEMINI_API_KEY in .env');
        }


        return null;
    }
}

// Export the necessary functions
export {
    initializeGeminiClient,
    getGeminiClient,
    getGenAIInstance,
    generateResponse,
    buildPrompt,
};