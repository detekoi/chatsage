// REVERTING to the standard named import style
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";

import logger from '../../lib/logger.js';
import config from '../../config/index.js';

// --- Define the System Instruction ---
const CHAT_SAGE_SYSTEM_INSTRUCTION = "You are ChatSage, a wise and helpful AI assistant in a Twitch chat. Be concise and engaging like a chatbot. Avoid repeating the user's name in the beginning of your response. This is Twitch, so it is populated with 'cool kids' who may be skeptical of overly bubbly AI responses. Do not use markdown in your responses.";

let genAI = null;
let generativeModel = null;

// --- NEW: Function Declaration for Search Decision ---
const checkSearchNeededTool = {
    functionDeclarations: [
        {
            name: "decide_if_search_needed",
            description: "Determines if external web search is required to provide an accurate, up-to-date, and factual answer to the user's query, considering the provided chat context and stream information. Call this ONLY when confidence in answering from internal knowledge is low OR the query explicitly asks for current/real-time information, specific obscure facts, or details about rapidly changing topics.",
            parameters: {
                type: "OBJECT",
                properties: {
                    user_query: {
                        type: "STRING",
                        description: "The specific question or query the user asked."
                    },
                    reasoning: {
                         type: "STRING",
                         description: "A brief explanation (1 sentence) why search is deemed necessary or not necessary based on the query and context."
                    },
                     search_required: {
                         type: "BOOLEAN",
                         description: "Set to true if search is necessary, false otherwise."
                     }
                },
                required: ["user_query", "reasoning", "search_required"]
            }
        }
    ]
};

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

// --- UPDATED Prompt Builder (Context only) ---
/**
 * Constructs the context part of the prompt. Persona and task are handled elsewhere.
 * @param {object} context - Context object.
 * @returns {string} The formatted context string.
 */
export function buildContextPrompt(context) {
    const game = context.streamGame || "N/A";
    const title = context.streamTitle || "N/A";
    const tags = context.streamTags || "N/A";
    const summary = context.chatSummary || "No summary available.";
    const history = context.recentChatHistory || "No recent messages.";

    // Return only the context parts
    return `
**Current Stream Information:**
Game: ${game}
Title: ${title}
Tags: ${tags}

**Chat Summary:**
${summary}

**Recent Messages:**
${history}`;
}

// --- UPDATED generateStandardResponse (Standard - no search) ---
/**
 * Generates a standard response using ONLY internal knowledge.
 * @param {string} contextPrompt - Context string from buildContextPrompt.
 * @param {string} userQuery - The user's query.
 * @returns {Promise<string | null>} Resolves with the generated text response, or null.
 */
export async function generateStandardResponse(contextPrompt, userQuery) {
    const model = getGeminiClient();
    const fullPrompt = `${contextPrompt}\n\n**User Query:** ${userQuery}\n\n**ChatSage Response:**`;
    logger.debug({ promptLength: fullPrompt.length }, 'Generating standard (no search) response');

    try {
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
            systemInstruction: { parts: [{ text: CHAT_SAGE_SYSTEM_INSTRUCTION }] }
        });
        
        const response = result.response;
        if (response.promptFeedback?.blockReason) {
            logger.warn({
                blockReason: response.promptFeedback.blockReason,
                safetyRatings: response.promptFeedback.safetyRatings,
            }, 'Gemini request blocked due to prompt safety settings.');
            return null;
        }

        if (!response.candidates?.length || !response.candidates[0].content) {
            logger.warn({ response }, 'Gemini response missing candidates or content.');
            return null;
        }

        const candidate = response.candidates[0];
        if (candidate.finishReason && candidate.finishReason !== 'STOP' && candidate.finishReason !== 'MAX_TOKENS') {
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
        logger.info({ responseLength: text.length }, 'Successfully generated standard response.');
        return text.trim();
    } catch (error) {
        logger.error({ err: error }, 'Error during standard generateContent call');
        return null;
    }
}

// --- UPDATED generateSearchResponse (WITH search tool) ---
/**
 * Generates a response WITH Google Search enabled.
 * @param {string} contextPrompt - Context string from buildContextPrompt.
 * @param {string} userQuery - The user's query.
 * @returns {Promise<string | null>} Resolves with the generated text response, or null.
 */
export async function generateSearchResponse(contextPrompt, userQuery) {
    if (!userQuery?.trim()) { return null; }
    const model = getGeminiClient();
    const fullPrompt = `${contextPrompt}\n\n**User Query:** ${userQuery}\n\n**ChatSage Response (using search results):**`;
    logger.debug({ promptLength: fullPrompt.length }, 'Generating search-grounded response');

    try {
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
            tools: [{ googleSearch: {} }],
            systemInstruction: { parts: [{ text: CHAT_SAGE_SYSTEM_INSTRUCTION }] }
        });

        const response = result.response;
        if (response.promptFeedback?.blockReason) {
            logger.warn({ blockReason: response.promptFeedback.blockReason }, 'Search-grounded Gemini request blocked due to prompt safety settings.');
            return null;
        }

        if (!response.candidates?.length || !response.candidates[0].content) {
            logger.warn('Search-grounded Gemini response missing candidates or content.');
            return null;
        }

        const candidate = response.candidates[0];
        if (candidate.citationMetadata?.citationSources?.length > 0) {
            logger.info({ citations: candidate.citationMetadata.citationSources }, 'Gemini response included search citations.');
        }

        if (candidate.finishReason && candidate.finishReason !== 'STOP' && candidate.finishReason !== 'MAX_TOKENS') {
            logger.warn({ finishReason: candidate.finishReason }, `Search-grounded Gemini generation finished unexpectedly: ${candidate.finishReason}`);
            if (candidate.finishReason === 'SAFETY') {
                logger.warn('Search-grounded Gemini response content blocked due to safety settings.');
            }
            return null;
        }

        if (!candidate.content?.parts?.length) {
            logger.warn('Search-grounded Gemini response candidate missing content parts.');
            return null;
        }

        const text = candidate.content.parts.map(part => part.text).join('');
        logger.info({ responseLength: text.length }, 'Successfully generated search-grounded response.');
        return text.trim();
    } catch (error) {
        logger.error({ err: error }, 'Error during search-grounded generateContent call');
        return null;
    }
}

// --- NEW: Function to Decide Search using Function Calling ---
/**
 * Makes the initial LLM call to decide if search is needed using function calling.
 * @param {string} contextPrompt - Context string from buildContextPrompt.
 * @param {string} userQuery - The user's query.
 * @returns {Promise<{searchNeeded: boolean, reasoning: string | null}>} Decision object.
 */
export async function decideSearchWithFunctionCalling(contextPrompt, userQuery) {
    if (!userQuery?.trim()) return { searchNeeded: false, reasoning: "Empty query" };
    const model = getGeminiClient();

    // Construct prompt for the decision-making call
    const decisionPrompt = `${contextPrompt}\n\n**User Query:** "${userQuery}"\n\n**Task:** Analyze the user query and context. Decide if Google Search is essential for an accurate answer by calling the 'decide_if_search_needed' function. Be conservative; only require search if absolutely necessary (e.g., for real-time data, recent events, obscure facts).`;

    logger.debug({ promptLength: decisionPrompt.length }, 'Attempting function calling decision for search');

    try {
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: decisionPrompt }] }],
            tools: checkSearchNeededTool,
            systemInstruction: { parts: [{ text: CHAT_SAGE_SYSTEM_INSTRUCTION }] }
        });

        const response = result.response;
        const candidate = response?.candidates?.[0];

        // Check if the model made a function call
        if (candidate?.content?.parts?.[0]?.functionCall) {
            const functionCall = candidate.content.parts[0].functionCall;
            if (functionCall.name === 'decide_if_search_needed') {
                const args = functionCall.args;
                const searchRequired = args?.search_required === true; // Explicit boolean check
                const reasoning = args?.reasoning || "No reasoning provided by model.";
                logger.info({ search_required: searchRequired, reasoning: reasoning }, 'Function call decision received.');
                return { searchNeeded: searchRequired, reasoning: reasoning };
            } else {
                logger.warn({ functionCallName: functionCall.name }, "Model called unexpected function for search decision.");
            }
        } else {
            logger.warn("Model did not make a function call for search decision. Defaulting to no search.");
            const textResponse = candidate?.content?.parts?.[0]?.text;
            if(textResponse) logger.debug({textResponse}, "Non-function-call response received for decision prompt.");
        }

        // Default to not searching if function call failed or wasn't made correctly
        return { searchNeeded: false, reasoning: "Model did not call decision function as expected." };

    } catch (error) {
        logger.error({ err: error }, 'Error during function calling decision API call');
        return { searchNeeded: false, reasoning: "API Error during decision" };
    }
}

// --- Text Summarization Function ---
/**
 * Summarizes the provided text using the Gemini API to fit within a target length.
 * @param {string} textToSummarize - The text content to be summarized.
 * @param {number} [targetCharLength=400] - An approximate target character length for the summary.
 * @returns {Promise<string|null>} The summarized text, or null on failure.
 */
export async function summarizeText(textToSummarize, targetCharLength = 400) {
    if (!textToSummarize || typeof textToSummarize !== 'string' || textToSummarize.trim().length === 0) {
        logger.error('summarizeText called with invalid textToSummarize.');
        return null;
    }
    const model = getGeminiClient(); // Ensures model is initialized

    // Construct a prompt specifically for summarization with a length constraint
    const summarizationPrompt = `Please summarize the following text concisely. Aim for a summary that is approximately under ${targetCharLength} characters long, capturing the key points.

Text to Summarize:
--- START ---
${textToSummarize}
--- END ---

Concise Summary:`;

    logger.debug({ promptLength: summarizationPrompt.length, targetLength: targetCharLength }, 'Attempting summarization Gemini API call');

    try {
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: summarizationPrompt }] }],
            systemInstruction: {
                role: "system",
                parts: [{ text: CHAT_SAGE_SYSTEM_INSTRUCTION }]
            }
        });
        const response = result.response;

        // Standard safety/validity checks
        if (response.promptFeedback?.blockReason) {
            logger.warn({ blockReason: response.promptFeedback.blockReason }, 'Summarization prompt blocked by Gemini safety settings.');
            return null;
        }
        if (!response.candidates?.length || !response.candidates[0].content) {
            logger.warn('Summarization response missing candidates or content.');
             return null;
        }
        const candidate = response.candidates[0];
        if (candidate.finishReason && candidate.finishReason !== 'STOP' && candidate.finishReason !== 'MAX_TOKENS') {
             logger.warn({ finishReason: candidate.finishReason }, `Summarization generation finished unexpectedly: ${candidate.finishReason}`);
              if (candidate.finishReason === 'SAFETY') { logger.warn('Summarization response content blocked due to safety settings.'); }
             return null;
        }
         if (!candidate.content?.parts?.length) {
            logger.warn('Summarization response candidate missing content parts.');
            return null;
        }

        const summary = candidate.content.parts.map(part => part.text).join('');
        logger.info({ originalLength: textToSummarize.length, summaryLength: summary.length }, 'Successfully generated summary from Gemini.');
        return summary.trim();

    } catch (error) {
        logger.error({ err: error, prompt: "[summarization prompt omitted]" }, 'Error during summarization Gemini API call');
        // Add specific error handling if needed
        return null;
    }
}

// --- Translation Function ---
/**
 * Translates text to the target language using the Gemini API.
 * @param {string} textToTranslate - The text to translate.
 * @param {string} targetLanguage - The language to translate into (e.g., "Spanish", "Japanese").
 * @returns {Promise<string|null>} The translated text, or null on failure.
 */
export async function translateText(textToTranslate, targetLanguage) {
    if (!textToTranslate || !targetLanguage) {
        logger.error('translateText called with missing text or target language.');
        return null;
    }
    const model = getGeminiClient();

    // Simple, direct translation prompt
    const translationPrompt = `You are an expert interpreter. Translate the following text into ${targetLanguage}. Do not include any other text or commentary:

"${textToTranslate}"

Translation:`;

    logger.debug({ targetLanguage, textLength: textToTranslate.length }, 'Attempting translation Gemini API call');

    try {
        const result = await model.generateContent(translationPrompt);
        const response = result.response;

        // Standard safety/validity checks
        if (response.promptFeedback?.blockReason) {
            logger.warn({ blockReason: response.promptFeedback.blockReason }, 'Translation prompt blocked by Gemini safety settings.');
            return null;
        }
        if (!response.candidates?.length || !response.candidates[0].content) {
            logger.warn('Translation response missing candidates or content.');
             return null;
        }
        const candidate = response.candidates[0];
        if (candidate.finishReason && candidate.finishReason !== 'STOP' && candidate.finishReason !== 'MAX_TOKENS') {
             logger.warn({ finishReason: candidate.finishReason }, `Translation generation finished unexpectedly: ${candidate.finishReason}`);
              if (candidate.finishReason === 'SAFETY') { logger.warn('Translation response content blocked due to safety settings.'); }
             return null;
        }
         if (!candidate.content?.parts?.length) {
            logger.warn('Translation response candidate missing content parts.');
            return null;
        }

        const translatedText = candidate.content.parts.map(part => part.text).join('');
        logger.info({ targetLanguage, originalLength: textToTranslate.length, translatedLength: translatedText.length }, 'Successfully generated translation from Gemini.');
        return translatedText.trim();

    } catch (error) {
        logger.error({ err: error, prompt: "[translation prompt omitted]" }, 'Error during translation Gemini API call');
        return null;
    }
}