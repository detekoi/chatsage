import { Type } from "@google/genai";
import logger from '../../../lib/logger.js';
import { getCurrentTime } from '../../../lib/timeUtils.js';
import { getGeminiClient, getGenAIInstance, getConfiguredModelId } from './core.js';
import { extractTextFromResponse, sleep } from './utils.js';
import { CHAT_SAGE_SYSTEM_INSTRUCTION } from './prompts.js';
import { standardAnswerTools, searchTool } from './tools.js';

/**
 * Uses the LLM to infer a valid IANA timezone for a given location string.
 * This is a specialized call, not a general purpose one.
 * @param {string} locationName - The name of the location (e.g., "San Diego", "London").
 * @returns {Promise<string|null>} The IANA timezone string or null if not found/error.
 */
export async function fetchIanaTimezoneForLocation(locationName) {
    if (!locationName || typeof locationName !== 'string' || locationName.trim().length === 0) {
        logger.error('fetchIanaTimezoneForLocation called with invalid locationName.');
        return null;
    }
    // Use a fresh, persona-less model instance for this specialized lookup
    const ai = getGenAIInstance();
    const modelId = process.env.GEMINI_MODEL_ID || getConfiguredModelId() || 'gemini-2.5-flash';

    // Highly specific prompt for IANA timezone, including edge cases
    const prompt = `What is the IANA timezone for "${locationName}"?
Examples:
- For "New York", respond: America/New_York
- For "London", respond: Europe/London
- For "Tokyo", respond: Asia/Tokyo
- For "San Diego", respond: America/Los_Angeles
- For "Los Angeles", respond: America/Los_Angeles
- For "Paris", respond: Europe/Paris
- For "Milan", respond: Europe/Rome
- For "Turin", respond: Europe/Rome
- For "Columbus, Ohio", respond: America/New_York
- For "Indianapolis", respond: America/Indiana/Indianapolis
- For "Phoenix", respond: America/Phoenix
- For "St. John's", respond: America/St_Johns
- For "Urumqi", respond: Asia/Urumqi
- For "Kathmandu", respond: Asia/Kathmandu
- For "Chatham Islands", respond: Pacific/Chatham
- For "Lord Howe Island", respond: Australia/Lord_Howe

Respond with ONLY the valid IANA timezone string. If the location is ambiguous, invalid, or you cannot determine a valid IANA timezone, respond with the exact string "UNKNOWN".`;

    logger.debug({ locationName, prompt }, 'Attempting to fetch IANA timezone via LLM');

    try {
        const result = await ai.models.generateContent({
            model: modelId,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
                temperature: 0.2,
                maxOutputTokens: 50
            }
        });
        const response = result;

        if (response.promptFeedback?.blockReason || !response.candidates?.length || !response.candidates[0].content) {
            logger.warn({ locationName, response }, 'Gemini response for IANA timezone was blocked, empty, or invalid.');
            return null;
        }

        const candidate = response.candidates[0];
        if (candidate.finishReason && candidate.finishReason !== 'STOP' && candidate.finishReason !== 'MAX_TOKENS') {
            logger.warn({ locationName, finishReason: candidate.finishReason }, `IANA timezone generation finished unexpectedly: ${candidate.finishReason}`);
            return null;
        }

        const ianaTimezone = candidate.content.parts.map(part => part.text).join('').trim();

        if (ianaTimezone === "UNKNOWN" || ianaTimezone.length < 3 || !ianaTimezone.includes('/')) {
            logger.warn({ locationName, received: ianaTimezone }, 'LLM could not determine a valid IANA timezone or returned UNKNOWN.');
            return null;
        }

        if (!/^[A-Za-z_]+\/[A-Za-z_+-]+$/.test(ianaTimezone)) {
            logger.warn({ locationName, received: ianaTimezone }, 'Received string does not look like a valid IANA timezone format.');
        }

        logger.info({ locationName, ianaTimezone }, 'Successfully fetched IANA timezone via LLM.');
        return ianaTimezone;

    } catch (error) {
        logger.error({ err: error, locationName }, 'Error during LLM call for IANA timezone');
        return null;
    }
}

// Update handleFunctionCall to support get_iana_timezone_for_location_tool
async function handleFunctionCall(functionCall) {
    if (!functionCall || !functionCall.name) return null;
    if (functionCall.name === 'getCurrentTime') {
        const args = functionCall.args || {};
        return Promise.resolve(getCurrentTime(args));
    }
    if (functionCall.name === 'get_iana_timezone_for_location_tool') {
        const location = functionCall.args?.location_name;
        if (!location) {
            logger.warn("get_iana_timezone_for_location_tool called without location_name arg.");
            return { error: "Location name not provided for timezone lookup." };
        }
        logger.info({ location }, "handleFunctionCall: get_iana_timezone_for_location_tool called by LLM. Delegating to fetchIanaTimezoneForLocation.");
        const ianaTimezone = await fetchIanaTimezoneForLocation(location);
        if (ianaTimezone) {
            return { iana_timezone: ianaTimezone, original_location: location };
        } else {
            return { error: `Could not determine IANA timezone for ${location}.` };
        }
    }
    // Add more tool handlers here as needed
    return null;
}

// --- UPDATED generateStandardResponse (Standard - no search) ---
/**
 * Generates a standard response using ONLY internal knowledge.
 * @param {string} contextPrompt - Context string from buildContextPrompt.
 * @param {string} userQuery - The user's query.
 * @returns {Promise<string | null>} Resolves with the generated text response, or null.
 */
export async function generateStandardResponse(contextPrompt, userQuery, options = {}) {
    const model = getGeminiClient();
    const thinkingLevel = options.thinkingLevel || 'high';

    // --- Add CRITICAL INSTRUCTION to systemInstruction ---
    const standardSystemInstruction = `${CHAT_SAGE_SYSTEM_INSTRUCTION}\n\nTOOL USE GUIDELINES:\n- You have access to a 'getCurrentTime' tool. Use it ONLY if the user explicitly asks for the current time or date (e.g., "what time is it?", "date today").\n- Do NOT use 'getCurrentTime' for queries about weather, facts, or general chat, even if they contain words like "now" or "today".`;

    const fullPrompt = `${contextPrompt}\n\nUSER: ${userQuery}\nREPLY: ≤300 chars. Answer the question directly and concisely. Prioritize substance and facts. No meta. Don't restate the question or context. Don't repeat the username.`;

    logger.debug({ promptLength: fullPrompt.length }, 'Generating standard (no search) response');

    try {
        // 1. Initial call with only answer tools AND the CRITICAL INSTRUCTION
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
            // IMPORTANT: tools must be an array; otherwise function calling may be ignored
            tools: [standardAnswerTools],
            toolConfig: { functionCallingConfig: { mode: "AUTO" } },
            systemInstruction: { parts: [{ text: standardSystemInstruction }] },
            generationConfig: {
                maxOutputTokens: 8192,
                responseMimeType: 'text/plain',
                thinkingConfig: { thinkingLevel }
            }
        });
        const response = result;
        const candidate = response.candidates?.[0];

        // 2. Check for function call (e.g., getCurrentTime)
        if (candidate?.content?.parts?.[0]?.functionCall) {
            const functionCall = candidate.content.parts[0].functionCall;
            if (functionCall.name === 'getCurrentTime' || functionCall.name === 'get_iana_timezone_for_location_tool') {
                logger.info({ functionCall }, 'Gemini requested function call');
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
                        tools: [standardAnswerTools],
                        toolConfig: { functionCallingConfig: { mode: "AUTO" } },
                        systemInstruction: { parts: [{ text: standardSystemInstruction }] },
                        generationConfig: {
                            maxOutputTokens: 8192,
                            responseMimeType: 'text/plain',
                            thinkingConfig: { thinkingLevel }
                        }
                    });
                    const followupResponse = followup;
                    const followupCandidate = followupResponse.candidates?.[0];
                    const textAfterFn = extractTextFromResponse(followupResponse, followupCandidate, 'standard-followup');
                    if (textAfterFn) {
                        logger.info({ responseLength: textAfterFn.length }, 'Standard response.');
                        return textAfterFn;
                    }
                    logger.warn('No extractable content in followup function-call response.');
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
            logger.warn({ query: userQuery, responseText: candidate?.content?.parts?.[0]?.text }, "LLM attempted to answer time/date query without function call. This response is likely incorrect.");
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

        const text = extractTextFromResponse(response, candidate, 'standard');
        if (!text) {
            logger.warn({ response }, 'Gemini response missing extractable text.');
            return null;
        }
        logger.info(`[LLM] Standard response generated: ${text.length} chars`);
        logger.debug({ responsePreview: text.substring(0, 100) }, 'Response preview');
        return text;
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
export async function generateSearchResponse(contextPrompt, userQuery, options = {}) {
    if (!userQuery?.trim()) { return null; }
    const model = getGeminiClient();
    const thinkingLevel = options.thinkingLevel || 'high';
    const fullPrompt = `${contextPrompt}\n\nUSER: ${userQuery}\nIMPORTANT: Search the web for up-to-date information to answer this question. Your response MUST be 420 characters or less (strict limit). Provide a direct, complete answer based on your search results. Include specific details from sources. Write complete sentences that fit within the limit.`;
    logger.debug({ promptLength: fullPrompt.length }, 'Generating search-grounded response');

    try {
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
            tools: searchTool,
            // Note: Do NOT include functionCallingConfig when no functionDeclarations are provided
            systemInstruction: { parts: [{ text: CHAT_SAGE_SYSTEM_INSTRUCTION }] },
            generationConfig: {
                maxOutputTokens: 8192,
                responseMimeType: 'text/plain',
                thinkingConfig: { thinkingLevel }
            }
        });

        const response = result;
        if (response.promptFeedback?.blockReason) {
            logger.warn({ blockReason: response.promptFeedback.blockReason }, 'Search-grounded Gemini request blocked due to prompt safety settings.');
            return null;
        }

        const candidate = response.candidates?.[0];
        if (!candidate) {
            logger.warn('Search-grounded Gemini response missing candidates or content.');
            return null;
        }
        // Transparency: log grounding metadata if present
        const groundingMetadata = candidate.groundingMetadata || response.candidates?.[0]?.groundingMetadata;
        if (groundingMetadata) {
            const sources = Array.isArray(groundingMetadata.groundingChunks)
                ? groundingMetadata.groundingChunks.slice(0, 3).map(c => c?.web?.uri).filter(Boolean)
                : undefined;
            logger.info({
                usedGoogleSearch: true,
                webSearchQueries: groundingMetadata.webSearchQueries,
                sources
            }, 'Search grounding metadata.');
        } else {
            logger.info({ usedGoogleSearch: false }, 'No search grounding metadata present.');
        }
        if (candidate.citationMetadata?.citationSources?.length > 0) {
            logger.info({ citations: candidate.citationMetadata.citationSources }, 'Gemini response included search citations.');
        }

        // Note: We no longer require explicit grounding signals; we trust the model when googleSearch is enabled.

        if (candidate.finishReason && candidate.finishReason !== 'STOP' && candidate.finishReason !== 'MAX_TOKENS') {
            logger.warn({ finishReason: candidate.finishReason }, `Search-grounded Gemini generation finished unexpectedly: ${candidate.finishReason}`);
            if (candidate.finishReason === 'SAFETY') {
                logger.warn('Search-grounded Gemini response content blocked due to safety settings.');
            }
            return null;
        }

        const text = extractTextFromResponse(response, candidate, 'search');
        if (!text) {
            logger.warn('Search-grounded Gemini response candidate missing extractable text.');
            return null;
        }
        const trimmedText = text.trim();
        logger.info(`[LLM] Search-grounded response generated: ${trimmedText.length} chars`);
        logger.debug({ responsePreview: trimmedText.substring(0, 100) }, 'Response preview');
        return trimmedText;
    } catch (error) {
        logger.error({ err: error }, 'Error during search-grounded generateContent call');
        return null;
    }
}

// --- NEW: Unified generation that lets the model decide to search or use tools ---
/**
 * Generates a response with BOTH googleSearch grounding and your function tools enabled.
 * The model decides when to search and when to call tools in a single request.
 * @param {string} contextPrompt
 * @param {string} userQuery
 * @returns {Promise<string|null>}
 */
export async function generateUnifiedResponse(contextPrompt, userQuery, options = {}) {
    if (!userQuery?.trim()) return null;
    const model = getGeminiClient();
    const thinkingLevel = options.thinkingLevel || 'high';
    const fullPrompt = `${contextPrompt}\n\nUSER: ${userQuery}\nREPLY: ≤320 chars, direct, grounded if needed. Answer the question directly. No meta.`;
    try {
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
            // IMPORTANT: Do not combine googleSearch tool with function calling / function tools in this SDK
            tools: [{ googleSearch: {} }],
            systemInstruction: { parts: [{ text: CHAT_SAGE_SYSTEM_INSTRUCTION }] },
            generationConfig: {
                maxOutputTokens: 8192,
                responseMimeType: 'text/plain',
                thinkingConfig: { thinkingLevel }
            }
        });
        const response = result;
        if (response.promptFeedback?.blockReason) {
            logger.warn({ blockReason: response.promptFeedback.blockReason }, 'Unified request blocked.');
            return null;
        }
        const candidate = response.candidates?.[0];
        if (!candidate) return null;
        // Transparency: log grounding metadata if present
        const groundingMetadata = candidate.groundingMetadata || response.candidates?.[0]?.groundingMetadata;
        if (groundingMetadata) {
            const sources = Array.isArray(groundingMetadata.groundingChunks)
                ? groundingMetadata.groundingChunks.slice(0, 3).map(c => c?.web?.uri).filter(Boolean)
                : undefined;
            logger.info({
                usedGoogleSearch: true,
                webSearchQueries: groundingMetadata.webSearchQueries,
                sources
            }, 'Unified: search grounding metadata.');
        } else {
            logger.info({ usedGoogleSearch: false }, 'Unified: no search grounding metadata present.');
        }
        if (candidate.citationMetadata?.citationSources?.length > 0) {
            logger.info({ citations: candidate.citationMetadata.citationSources }, 'Unified response included citations.');
        }
        const text = extractTextFromResponse(response, candidate, 'unified');
        return text?.trim() || null;
    } catch (err) {
        logger.error({ err }, 'Error during unified generateContent call');
        return null;
    }
}

// --- Text Summarization Function ---
/**
 * Summarizes the provided text using the Gemini API to fit within a target length.
 * @param {string} textToSummarize - The text content to be summarized.
 * @param {number} [targetCharLength=400] - An approximate target character length for the summary.
 * @returns {Promise<string|null>} The summarized text, or null on failure.
 */
export async function summarizeText(textToSummarize, targetCharLength = 400, options = {}) {
    if (!textToSummarize || typeof textToSummarize !== 'string' || textToSummarize.trim().length === 0) {
        logger.error('summarizeText called with invalid textToSummarize.');
        return null;
    }
    // Use a fresh, persona-less model instance for this non-conversational utility task
    const ai = getGenAIInstance();
    const modelId = process.env.GEMINI_MODEL_ID || getConfiguredModelId() || 'gemini-2.5-flash-lite';

    // Simplified summarization prompt using current best practices
    const summarizationPrompt = `Summarize the following text in under ${targetCharLength} characters. Focus on the main points, avoid usernames/greetings, use plain text only.

Text to summarize:
${textToSummarize}`;

    logger.debug({ promptLength: summarizationPrompt.length, targetLength: targetCharLength }, 'Attempting summarization Gemini API call');

    // Retry with exponential backoff on 503s
    const maxRetries = 3;
    const baseDelayMs = 500;

    function isRetryable(error) {
        const status = error?.status || error?.response?.status;
        if (status === 503) return true;
        const message = error?.message || '';
        return /\b503\b|Service Unavailable|timeout/i.test(message);
    }

    async function generateOnce() {
        return await ai.models.generateContent({
            model: modelId,
            contents: [{ role: "user", parts: [{ text: summarizationPrompt }] }],
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        summary: { type: Type.STRING }
                    },
                    required: ['summary'],
                    propertyOrdering: ['summary']
                },
                maxOutputTokens: 8192,
                temperature: 0.3,
                thinkingConfig: { thinkingLevel: options.thinkingLevel || 'high' }
            }
        });
    }

    let response;
    try {
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                response = await generateOnce();
                break;
            } catch (error) {
                const attemptNum = attempt + 1;
                if (isRetryable(error) && attempt < maxRetries - 1) {
                    const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 150);
                    logger.warn({ attempt: attemptNum, delay, err: { message: error.message, status: error?.status } }, 'Summarization call failed with retryable error (likely timeout/503). Retrying with backoff.');
                    await sleep(delay);
                    continue;
                }
                throw error;
            }
        }
        if (!response) {
            logger.error('Summarization failed after retries with no response.');
            return null;
        }

        // Standard safety/validity checks
        if (response.promptFeedback?.blockReason) {
            logger.warn({ blockReason: response.promptFeedback.blockReason }, 'Summarization prompt blocked by Gemini safety settings.');
            return null;
        }
        const candidate = response.candidates?.[0];
        if (!candidate) {
            logger.warn('Summarization response missing candidates or content.');
            return null;
        }
        if (candidate.finishReason && candidate.finishReason !== 'STOP' && candidate.finishReason !== 'MAX_TOKENS') {
            logger.warn({ finishReason: candidate.finishReason }, `Summarization generation finished unexpectedly: ${candidate.finishReason}`);
            if (candidate.finishReason === 'SAFETY') { logger.warn('Summarization response content blocked due to safety settings.'); }
            return null;
        }

        // Robust extraction using current Gemini structured output best practices
        const jsonText = extractTextFromResponse(response, candidate, 'summarize-structured');
        let parsedSummary = null;

        if (jsonText && typeof jsonText === 'string') {
            // Try multiple parsing strategies for maximum robustness

            // Strategy 1: Direct JSON parse
            try {
                const obj = JSON.parse(jsonText);
                if (obj && typeof obj.summary === 'string' && obj.summary.trim().length > 0) {
                    parsedSummary = obj.summary.trim();
                    logger.debug('Successfully parsed JSON summary directly');
                }
            } catch (parseError) {
                logger.debug({ parseError: parseError.message }, 'Direct JSON parse failed, trying recovery strategies');

                // Strategy 2: Clean and retry JSON parse
                const cleanedJson = jsonText.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
                try {
                    const obj = JSON.parse(cleanedJson);
                    if (obj && typeof obj.summary === 'string' && obj.summary.trim().length > 0) {
                        parsedSummary = obj.summary.trim();
                        logger.debug('Successfully parsed cleaned JSON summary');
                    }
                } catch (cleanError) {
                    // Strategy 3: Regex extraction from malformed JSON
                    const summaryMatch = jsonText.match(/["']summary["']\s*:\s*["']([^"']*)["']/i);
                    if (summaryMatch && summaryMatch[1]) {
                        parsedSummary = summaryMatch[1].trim();
                        logger.debug('Recovered summary from malformed JSON via regex');
                    } else {
                        // Strategy 4: Extract any quoted text that might be the summary
                        const quotedMatch = jsonText.match(/["']([^"']{10,})["']/i);
                        if (quotedMatch && quotedMatch[1]) {
                            parsedSummary = quotedMatch[1].trim();
                            logger.debug('Extracted summary from quoted text');
                        }
                    }
                }
            }
        }

        let summary = parsedSummary;
        let summarySource = parsedSummary ? 'structured' : 'fallback';

        // If LLM summarization failed, return null to let caller handle fallback
        if (!summary || summary.trim().length === 0) {
            logger.warn('LLM summarization failed - no valid summary extracted from API response');
            return null;
        }

        // Final length check - import and use smartTruncate
        if (summary.length > targetCharLength) {
            // Import smartTruncate from llmUtils at the top if not already done
            const { smartTruncate } = await import('../llmUtils.js');
            summary = smartTruncate(summary, targetCharLength);
        }

        logger.info({
            originalLength: textToSummarize.length,
            summaryLength: summary.length,
            source: summarySource
        }, 'Successfully generated summary.');

        return summary.trim();

    } catch (error) {
        logger.error({ err: error, prompt: "[summarization prompt omitted]" }, 'Error during summarization Gemini API call');
        return null;
    }
}
