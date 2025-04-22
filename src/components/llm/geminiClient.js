// REVERTING to the standard named import style
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";

import logger from '../../lib/logger.js';
import config from '../../config/index.js';

let genAI = null;
let generativeModel = null;

/**
 * Initializes the GoogleGenerativeAI client and the specific model.
 */
// Add export keyword directly
export function initializeGeminiClient(geminiConfig) {
    if (genAI) {
        logger.warn('Gemini client already initialized.');
        return;
    }

    if (!geminiConfig || !geminiConfig.apiKey || !geminiConfig.modelId) {
        throw new Error('Missing required Gemini configuration (apiKey, modelId).');
    }

    try {
        logger.info(`Initializing GoogleGenerativeAI with model: ${geminiConfig.modelId}`);
        // Use the named import directly as a constructor
        genAI = new GoogleGenerativeAI(geminiConfig.apiKey); // Use named import

        // This is the standard method we expect to work with recent SDK versions
        generativeModel = genAI.getGenerativeModel({
            model: geminiConfig.modelId,
            safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            ],
             generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 250,
            }
        });
        logger.info('Gemini client and model initialized successfully.');
    } catch (error) {
        logger.fatal({ err: { message: error.message, stack: error.stack, name: error.name } }, 'Failed to initialize GoogleGenerativeAI client.');
        genAI = null;
        generativeModel = null;
        throw error;
    }
}

// ... (rest of the file with export keywords on functions) ...

export function getGenAIInstance() {
     if (!genAI) {
        throw new Error('Gemini client (GenAI) has not been initialized.');
    }
    return genAI;
}

export function getGeminiClient() {
    if (!generativeModel) {
        throw new Error('Gemini client (Model) has not been initialized. Call initializeGeminiClient first.');
    }
    return generativeModel;
}

export function buildPrompt(context) {
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

export async function generateResponse(context) {
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
                prompt: "[prompt omitted]"
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
        } else if (error.message?.includes('API key not valid')) {
            logger.error('Gemini API key is not valid. Please check GEMINI_API_KEY in .env');
        }

        return null;
    }
}

// --- NEW: Search Grounded Response Generation ---
/**
 * Generates a response using the Gemini API, enabling the Google Search tool.
 * Takes a pre-formatted prompt string as input.
 * @param {string} promptText - The prompt instructing the model to perform a search.
 * @returns {Promise<string | null>} Resolves with the generated text response, or null if generation failed/blocked.
 */
export async function generateSearchGroundedResponse(promptText) {
    if (!promptText || typeof promptText !== 'string' || promptText.trim().length === 0) {
        logger.error('generateSearchGroundedResponse called with invalid promptText.');
        return null;
    }
    const model = getGeminiClient(); // Ensures model is initialized

    logger.debug({ promptLength: promptText.length }, 'Attempting search-grounded Gemini API call');

    try {
        const result = await model.generateContent({
             contents: [{ role: "user", parts: [{ text: promptText }] }],
             // Enable the Google Search tool (aka "grounding")
             tools: [{
                 googleSearch: {} // Enable Google Search
             }],
             // Tool config can be added here if needed (e.g., disableSemanticFiltering)
             // tool_config: { function_calling_config: { mode: ... } } // For function calling, not needed for basic search
        });

        const response = result.response;

        // Standard safety/validity checks
        if (response.promptFeedback?.blockReason) {
            logger.warn({ blockReason: response.promptFeedback.blockReason }, 'Search-grounded Gemini request blocked due to prompt safety settings.');
            return null;
        }
        if (!response.candidates?.length || !response.candidates[0].content) {
            logger.warn('Search-grounded Gemini response missing candidates or content.');
             return null;
        }

        const candidate = response.candidates[0];

         // Check for API citations (evidence from search) - optional but informative
        if (candidate.citationMetadata?.citationSources?.length > 0) {
            logger.info({ citations: candidate.citationMetadata.citationSources }, 'Gemini response included search citations.');
            // NOTE: We are currently just returning the text, not the structured citation info.
            // Future enhancement: Extract and format citations if desired.
        } else {
            logger.info('Gemini response did not include specific search citations (or grounding was not used).');
        }


        if (candidate.finishReason && candidate.finishReason !== 'STOP' && candidate.finishReason !== 'MAX_TOKENS') {
             logger.warn({ finishReason: candidate.finishReason }, `Search-grounded Gemini generation finished unexpectedly: ${candidate.finishReason}`);
              if (candidate.finishReason === 'SAFETY') { logger.warn('Search-grounded Gemini response content blocked due to safety settings.'); }
             return null;
        }
         if (!candidate.content?.parts?.length) {
            logger.warn('Search-grounded Gemini response candidate missing content parts.');
            return null;
        }

        const text = candidate.content.parts.map(part => part.text).join('');
        logger.info({ responseLength: text.length, finishReason: candidate.finishReason || 'N/A' }, 'Successfully generated search-grounded response from Gemini.');
        return text.trim();

    } catch (error) {
        logger.error({ err: error, prompt: "[prompt omitted]" }, 'Error during search-grounded Gemini API call');
        // ... add specific error handling (rate limits, API key, network) as in generateResponse ...
        if (error.message?.includes('API key not valid')) { logger.error('Gemini API key is not valid.'); }
        // Add retry logic if needed for transient errors
        return null;
    }
}
