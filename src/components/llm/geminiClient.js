import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/genai";
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
        genAI = new GoogleGenerativeAI(geminiConfig.apiKey);
        generativeModel = genAI.getGenerativeModel({
            model: geminiConfig.modelId,
            // Default safety settings - block potentially harmful content
            // Adjust these thresholds based on testing and requirements
            safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            ],
             generationConfig: {
                // Adjust temperature for creativity vs. predictability (0.0 - 1.0)
                temperature: 0.7,
                 // Limit the maximum number of tokens in the generated response
                maxOutputTokens: 250, // Adjust as needed for typical chat responses
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
    // Use "N/A" or similar for missing optional context parts
    const game = context.streamGame || "N/A";
    const title = context.streamTitle || "N/A";
    const tags = context.streamTags || "N/A";
    const summary = context.chatSummary || "No summary available.";
    const history = context.recentChatHistory || "No recent messages.";

    // Ensure required parts are present
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

StreamSage Response:`; // Added bot name for clarity in prompt
}


/**
 * Generates a response using the Gemini API based on provided context.
 * @param {object} context - Context object (see buildPrompt for structure).
 * @returns {Promise<string | null>} Resolves with the generated text response, or null if generation failed or was blocked.
 */
async function generateResponse(context) {
    const model = getGeminiClient(); // Ensures model is initialized
    let promptText;

    try {
        promptText = buildPrompt(context);
        logger.debug({ prompt: promptText }, 'Generated prompt for Gemini API');
    } catch (error) {
         logger.error({ err: error }, 'Failed to build prompt.');
         return null; // Cannot proceed without a valid prompt
    }

    try {
        const result = await model.generateContent(promptText);
        const response = result.response;

        // Check for safety blocks first
        if (response.promptFeedback?.blockReason) {
            logger.warn({
                blockReason: response.promptFeedback.blockReason,
                safetyRatings: response.promptFeedback.safetyRatings,
                prompt: promptText // Log prompt that caused block
            }, 'Gemini request blocked due to prompt safety settings.');
            return null; // Indicate blocked prompt
        }

        if (!response.candidates || response.candidates.length === 0 || !response.candidates[0].content) {
             logger.warn({ response }, 'Gemini response missing candidates or content.');
             return null;
        }

        // Check finish reason for the first candidate
        const candidate = response.candidates[0];
        if (candidate.finishReason !== 'STOP' && candidate.finishReason !== 'MAX_TOKENS') {
             logger.warn({
                finishReason: candidate.finishReason,
                safetyRatings: candidate.safetyRatings, // Safety ratings can also be on candidate
             }, `Gemini generation finished unexpectedly: ${candidate.finishReason}`);
             if (candidate.finishReason === 'SAFETY') {
                 logger.warn('Gemini response content blocked due to safety settings.');
             }
             return null; // Indicate blocked or problematic response
        }

        const text = candidate.content.parts.map(part => part.text).join('');
        logger.info({ responseLength: text.length, finishReason: candidate.finishReason }, 'Successfully generated response from Gemini.');
        return text.trim();

    } catch (error) {
        // Handle specific API errors based on recommendations in spec 5.3
        logger.error({ err: error, prompt: promptText }, 'Error during Gemini API call');

        // TODO: Implement retry logic with exponential backoff for specific error types
        // (e.g., 429 RESOURCE_EXHAUSTED, 500 INTERNAL, 503 UNAVAILABLE)
        // This basic version just logs and returns null.

        if (error.message && error.message.includes('429')) { // Simple check for rate limit
             logger.warn('Gemini API rate limit likely exceeded. Consider backoff/retry.');
        } else if (error.message && (error.message.includes('500') || error.message.includes('503'))) {
             logger.warn('Gemini API server error encountered. Consider backoff/retry.');
        }

        return null; // Indicate failure
    }
}

// Export the necessary functions
export {
    initializeGeminiClient,
    getGeminiClient,
    getGenAIInstance,
    generateResponse,
    buildPrompt, // Exporting buildPrompt might be useful for testing/debugging
};