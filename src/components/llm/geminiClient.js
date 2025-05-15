// REVERTING to the standard named import style
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";

import logger from '../../lib/logger.js';
import config from '../../config/index.js';
import { getCurrentTime } from '../../lib/timeUtils.js';

// --- Define the System Instruction ---
const CHAT_SAGE_SYSTEM_INSTRUCTION = `
You are ChatSage, a wise and helpful AI assistant in a Twitch chat. Be concise and engaging like a chatbot. Avoid repeating the user's name in the beginning of your response. This is Twitch, so it is populated with 'cool kids' who may be skeptical of overly bubbly AI responses. Do not use any markdown formatting like asterisks, underscores, or other markdown syntax. All text must be plain text only, with no special formatting characters.

IMPORTANT: If your response involves multiple steps or pieces of information (for example, confirming an answer AND asking a new question), you must combine them into a single, coherent message. Do not say things like 'Next question coming up...' and then end your response. Instead, state the confirmation and then immediately ask the next question in the same message. Never split your response into multiple turns or imply that you will continue in a follow-up message.`;

let genAI = null;
let generativeModel = null;

// --- Tool Definitions (Keep the structure) ---
const decideSearchTool = {
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

const standardAnswerTools = {
    functionDeclarations: [
        {
            name: "getCurrentTime",
            description: "Get the current date and time for a specified timezone. Defaults to UTC if no timezone is provided.",
            parameters: {
                type: "OBJECT",
                properties: {
                    timezone: {
                        type: "STRING",
                        description: "Optional. The IANA timezone name (e.g., 'Europe/London', 'America/New_York', 'UTC', 'GMT')."
                    }
                },
                required: []
            }
        }
        // Add other answer-generating tools here later if needed
    ]
};

const searchTool = [{ googleSearch: {} }]; // Gemini specific format for search

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
    const channelName = context.channelName || "N/A"; 
    const game = context.streamGame || "N/A";
    const title = context.streamTitle || "N/A";
    const tags = context.streamTags || "N/A";
    const summary = context.chatSummary || "No summary available.";
    const history = context.recentChatHistory || "No recent messages.";

    // Return only the context parts
    return `
**Current Stream Information:**
Channel: ${channelName}
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

    // --- Add CRITICAL INSTRUCTION to systemInstruction ---
    const standardSystemInstruction = `${CHAT_SAGE_SYSTEM_INSTRUCTION}\n\nCRITICAL INSTRUCTION: If the User Query asks for the current time or date, you MUST call the 'getCurrentTime' function tool to get the accurate information. Do NOT answer time/date queries from your internal knowledge.`;

    const fullPrompt = `${contextPrompt}\n\n**User Query:** ${userQuery}\n\n**ChatSage Response:**`;

    logger.debug({ promptLength: fullPrompt.length }, 'Generating standard (no search) response');

    try {
        // 1. Initial call with only answer tools AND the CRITICAL INSTRUCTION
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
            tools: standardAnswerTools,
            systemInstruction: { parts: [{ text: standardSystemInstruction }] }
        });
        const response = result.response;
        const candidate = response.candidates?.[0];

        // 2. Check for function call (e.g., getCurrentTime)
        if (candidate?.content?.parts?.[0]?.functionCall) {
            const functionCall = candidate.content.parts[0].functionCall;
            if (functionCall.name === 'getCurrentTime') {
                logger.info({ functionCall }, 'Gemini requested getCurrentTime function call');
                const functionResult = await handleFunctionCall(functionCall);
                if (functionResult) {
                    // 3. Send function result back to Gemini
                    const history = [
                        { role: "user", parts: [{ text: fullPrompt }] },
                        { role: "model", parts: candidate.content.parts },
                        {
                            role: "function",
                            parts: [{
                                functionResponse: {
                                    name: functionCall.name,
                                    response: functionResult
                                }
                            }]
                        }
                    ];
                    logger.debug({ history }, "Sending function call result back to model.");
                    const followup = await model.generateContent({
                        contents: history,
                        tools: standardAnswerTools,
                        systemInstruction: { parts: [{ text: standardSystemInstruction }] }
                    });
                    const followupResponse = followup.response;
                    const followupCandidate = followupResponse.candidates?.[0];
                    if (followupCandidate?.content?.parts?.length) {
                        const text = followupCandidate.content.parts.map(part => part.text).join('');
                        logger.info({ responseLength: text.length }, 'Successfully generated function-call response.');
                        return text.trim();
                    }
                    logger.warn('No content in followup function-call response.');
                    return null;
                } else {
                    logger.warn({ functionCall }, 'handleFunctionCall did not return a valid result.');
                    return null;
                }
            } else {
                logger.warn({ functionCall }, 'Gemini requested an unexpected function call during standard response generation.');
                return null;
            }
        }

        // 4. Standard text response (no function call - this is where the hallucination happened)
        // Check if it TRIED to answer a time query without the function
        if (/\b(time|date)\b/i.test(userQuery) && !candidate?.content?.parts?.[0]?.functionCall) {
            logger.warn({query: userQuery, responseText: candidate?.content?.parts?.[0]?.text}, "LLM attempted to answer time/date query without function call. This response is likely incorrect.");
            // Optionally return a specific message here instead of the hallucinated text
            // return "Sorry, I had trouble fetching the exact time. Please try again.";
        }

        if (response.promptFeedback?.blockReason) {
            logger.warn({
                blockReason: response.promptFeedback.blockReason,
                safetyRatings: response.promptFeedback.safetyRatings,
            }, 'Gemini request blocked due to prompt safety settings.');
            return null;
        }

        if (!candidate?.content?.parts?.length) {
            logger.warn({ response }, 'Gemini response missing candidates or content.');
            return null;
        }

        const text = candidate.content.parts.map(part => part.text).join('');
        logger.info({ responseLength: text.length }, 'Successfully generated standard text response (no function call).');
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
            tools: searchTool,
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

    // MODIFIED: Make the prompt more robust for various types of "userQuery"
    const decisionPrompt = `${contextPrompt}

User's effective request/topic for consideration: "${userQuery}"

**TASK:**
Your task is to determine if external web search (Google Search) is *essential* to fulfill the user's request or generate high-quality, factually accurate content about the given topic/request, especially considering any provided context or exclusion instructions.

You MUST call the 'decide_if_search_needed' function with your decision.
Do NOT attempt to answer or fulfill the user's request directly in this step.

**CRITERIA FOR REQUIRING SEARCH (set search_required: true):**
* The request involves real-time information (e.g., news, current events after late 2023, weather, stock prices).
* The request is about specific, obscure facts, or niche topics not commonly known.
* The request pertains to rapidly changing information.
* The request is for generating content (like a riddle or trivia) about a specific named entity (person, place, game, movie, book, etc.) where up-to-date or nuanced details are important for quality and accuracy.
* The request involves video game guidance or specific game lore details.
* The provided context (if any) is insufficient to confidently answer.

**CRITERIA FOR NOT REQUIRING SEARCH (set search_required: false):**
* The request is for general knowledge that is widely known and stable.
* The request is about creative generation on a very broad topic where specific facts are less critical than the creative output itself (unless accuracy is stressed).
* The request can be fully answered using the provided context or general knowledge.
* The user's query is ONLY for the current time or date (this is handled by a different tool, so search is not needed for the decision function itself).

Based on the above, make your decision.`;

    logger.debug({ promptLength: decisionPrompt.length, userQueryFromCaller: userQuery }, 'Attempting function calling decision for search');
    try {
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: decisionPrompt }] }],
            tools: decideSearchTool,
            toolConfig: {
                functionCallingConfig: {
                    mode: "ANY",
                }
            },
            systemInstruction: { parts: [{ text: "You are an AI assistant that decides if search is needed for a query." }] }
        });

        const response = result.response;
        const candidate = response?.candidates?.[0];

        if (candidate?.content?.parts?.[0]?.functionCall) {
            const functionCall = candidate.content.parts[0].functionCall;
            if (functionCall.name === 'decide_if_search_needed') {
                const args = functionCall.args;
                const searchRequired = args?.search_required === true;
                const reasoning = args?.reasoning || "No reasoning provided by model.";
                logger.info({ search_required: searchRequired, reasoning: reasoning, called_args: args }, 'Function call decision received.');
                return { searchNeeded: searchRequired, reasoning: reasoning };
            } else {
                logger.warn({ functionCallName: functionCall.name }, "Model called unexpected function for search decision.");
            }
        } else {
            logger.warn("Model did not make a function call for search decision. Defaulting to no search.");
            const textResponse = candidate?.content?.parts?.[0]?.text;
            if(textResponse) logger.debug({textResponse}, "Non-function-call response received for decision prompt.");
        }

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
    const translationPrompt = `You are an expert interpreter. Translate the following text into ${targetLanguage}. Do not include any other text or commentary. Do not wrap your translation in quotation marks:

${textToTranslate}

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
        // Only remove quotation marks if they surround the entire message
        // This preserves quotation marks used as punctuation within the text
        const cleanedText = translatedText.replace(/^"(.*)"$/s, '$1').trim();
        logger.info({ targetLanguage, originalLength: textToTranslate.length, translatedLength: cleanedText.length }, 'Successfully generated translation from Gemini.');
        return cleanedText;

    } catch (error) {
        logger.error({ err: error, prompt: "[translation prompt omitted]" }, 'Error during translation Gemini API call');
        return null;
    }
}

/**
 * Handles Gemini function calls for tools (e.g., getCurrentTime).
 * @param {object} functionCall - The functionCall object from Gemini response.
 * @returns {object|null} The function result object or null if not handled.
 */
async function handleFunctionCall(functionCall) {
    if (!functionCall || !functionCall.name) return null;
    if (functionCall.name === 'getCurrentTime') {
        const args = functionCall.args || {};
        // getCurrentTime is synchronous, but wrap in Promise.resolve for uniformity
        return Promise.resolve(getCurrentTime(args));
    }
    // Add more tool handlers here as needed
    return null;
}