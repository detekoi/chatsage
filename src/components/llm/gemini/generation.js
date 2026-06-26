import { Type } from "@google/genai";
import logger from '../../../lib/logger.js';
import { getCurrentTime } from '../../../lib/timeUtils.js';
import { getGeminiClient, getGenAIInstance, getConfiguredModelId, generateLiteContent } from './core.js';
import { extractTextFromResponse, safeExtractText, safeParseJsonResponse } from './utils.js';
import { CHAT_SAGE_SYSTEM_INSTRUCTION } from './prompts.js';
import { standardAnswerTools, searchTool } from './tools.js';

// --- UPDATED: Timezone Lookup with Structured Output ---
const TimezoneSchema = {
    type: Type.OBJECT,
    properties: {
        iana_timezone: { type: Type.STRING, description: "Valid IANA timezone string (e.g. 'America/New_York') or 'UNKNOWN'." }
    },
    required: ["iana_timezone"]
};

/**
 * Uses the LLM to infer a valid IANA timezone for a given location string.
 */
export async function fetchIanaTimezoneForLocation(locationName) {
    if (!locationName || typeof locationName !== 'string' || locationName.trim().length === 0) {
        logger.error('fetchIanaTimezoneForLocation called with invalid locationName.');
        return null;
    }
    const model = getGeminiClient();

    const prompt = `What is the IANA timezone for "${locationName}"?
Examples: "New York" -> "America/New_York", "Tokyo" -> "Asia/Tokyo".
If unknown or ambiguous, return "UNKNOWN".
Return STRICT JSON.`;

    try {
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.0,
                responseMimeType: 'application/json',
                responseSchema: TimezoneSchema
            }
        });

        const parsed = safeParseJsonResponse(result, '[Timezone]');
        if (parsed) {
            const tz = parsed.iana_timezone;
            if (tz && tz !== 'UNKNOWN') {
                return tz;
            }
        }
        return null;
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
        logger.info({ location }, "handleFunctionCall: get_iana_timezone_for_location_tool called override.");
        const ianaTimezone = await fetchIanaTimezoneForLocation(location);
        if (ianaTimezone) {
            return { iana_timezone: ianaTimezone, original_location: location };
        } else {
            return { error: `Could not determine IANA timezone for ${location}.` };
        }
    }
    return null;
}

// --- Standard Response ---
export async function generateStandardResponse(contextPrompt, userQuery, options = {}) {
    const model = getGeminiClient();
    const thinkingLevel = options.thinkingLevel || 'high';
    const botLanguage = options.botLanguage || null;
    let standardSystemInstruction = `${CHAT_SAGE_SYSTEM_INSTRUCTION}\n\nTOOL USE GUIDELINES:\n- You have access to a 'getCurrentTime' tool. Use it ONLY if the user explicitly asks for the current time or date.\n- Do NOT use 'getCurrentTime' for general facts.`;
    if (botLanguage) {
        standardSystemInstruction += ` You MUST respond entirely in ${botLanguage}.`;
    }
    const fullPrompt = `${contextPrompt}\n\nUSER: ${userQuery}\nREPLY: ≤300 chars. Answer directly.`;
    const emoteImageParts = options.emoteImageParts || [];

    try {
        // Note: Cannot combine responseMimeType: 'application/json' with custom function tools in Gemini 3
        const userParts = [{ text: fullPrompt }, ...emoteImageParts];
        const result = await model.generateContent({
            contents: [{ role: "user", parts: userParts }],
            tools: [standardAnswerTools],
            toolConfig: { functionCallingConfig: { mode: "AUTO" } },
            systemInstruction: { parts: [{ text: standardSystemInstruction }] },
            generationConfig: {
                thinkingConfig: { thinkingLevel }
            }
        });

        const response = result;
        const candidate = response.candidates?.[0];

        // Check for function call
        if (candidate?.content?.parts?.[0]?.functionCall) {
            const functionCall = candidate.content.parts[0].functionCall;
            const functionResult = await handleFunctionCall(functionCall);
            if (functionResult) {
                const history = [
                    { role: "user", parts: [{ text: fullPrompt }] },
                    { role: "model", parts: candidate.content.parts },
                    { role: "user", parts: [{ functionResponse: { name: functionCall.name, response: functionResult } }] }
                ];
                const followup = await model.generateContent({
                    contents: history,
                    tools: [standardAnswerTools],
                    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
                    systemInstruction: { parts: [{ text: standardSystemInstruction }] },
                    generationConfig: {
                        thinkingConfig: { thinkingLevel }
                    }
                });

                const followupCandidate = followup.candidates?.[0];
                if (followupCandidate?.finishReason === 'SAFETY') {
                    logger.warn({ prompt: userQuery }, 'Followup response blocked by safety filters.');
                    return "I can't answer that due to safety guidelines.";
                }

                const followupResponseText = safeExtractText(followup, 'standard-followup');
                return followupResponseText?.trim() || null;
            }
        }

        const responseText = safeExtractText(result, 'standard');
        return responseText?.trim() || null;

    } catch (error) {
        // Check for 503 Overloaded or other retryable errors? SDK usually handles retries if configured.
        logger.error({ err: error }, 'Error during standard generateContent call');
        return null;
    }
}

// --- Search Response ---
const SEARCH_SYSTEM_INSTRUCTION = `${CHAT_SAGE_SYSTEM_INSTRUCTION}

CRITICAL FOR !search COMMAND: Your training knowledge about world events, product releases, announcements, and anything time-sensitive is UNRELIABLE and likely OUTDATED. You MUST use the Google Search tool to fetch current, real-world information before answering. Do NOT answer from memory for any factual or recent-events query — always search first, then answer based on what you find.`;

export async function generateSearchResponse(contextPrompt, userQuery, options = {}) {
    if (!userQuery?.trim()) return null;
    const model = getGeminiClient();
    const thinkingLevel = options.thinkingLevel || 'high';
    const botLanguage = options.botLanguage || null;
    let searchSystemInstruction = SEARCH_SYSTEM_INSTRUCTION;
    if (botLanguage) {
        searchSystemInstruction += ` You MUST respond entirely in ${botLanguage}.`;
    }
    const fullPrompt = `${contextPrompt}\n\nUSER: ${userQuery}\nSearch the web right now and answer based on current results. Response ≤ 420 chars.`;
    const emoteImageParts = options.emoteImageParts || [];

    try {
        const userParts = [{ text: fullPrompt }, ...emoteImageParts];
        const result = await model.generateContent({
            contents: [{ role: "user", parts: userParts }],
            tools: searchTool,
            systemInstruction: { parts: [{ text: searchSystemInstruction }] },
            generationConfig: { responseMimeType: 'text/plain', thinkingConfig: { thinkingLevel } }
        });

        const candidate = result.candidates?.[0];
        const groundingMetadata = candidate?.groundingMetadata || null;
        // Logging for grounding
        if (groundingMetadata) {
            const sources = Array.isArray(groundingMetadata.groundingChunks)
                ? groundingMetadata.groundingChunks.slice(0, 3).map(c => c?.web?.uri).filter(Boolean)
                : undefined;
            logger.info({ usedGoogleSearch: true, webSearchQueries: groundingMetadata.webSearchQueries, sources }, '[SearchResponse] Search grounded.');
        } else {
            logger.info({ usedGoogleSearch: false }, '[SearchResponse] No search grounding metadata present.');
        }
        const text = safeExtractText(result, 'search')?.trim() || null;
        return text;
    } catch (error) {
        if (emoteImageParts.length > 0) {
            logger.warn({ err: error }, 'Search request with multimodal emotes failed. Retrying without image parts.');
            try {
                const userParts = [{ text: fullPrompt }];
                const result = await model.generateContent({
                    contents: [{ role: "user", parts: userParts }],
                    tools: searchTool,
                    systemInstruction: { parts: [{ text: searchSystemInstruction }] },
                    generationConfig: { responseMimeType: 'text/plain', thinkingConfig: { thinkingLevel } }
                });
                const candidate = result.candidates?.[0];
                const text = safeExtractText(result, 'search')?.trim() || null;
                return text;
            } catch (retryError) {
                logger.error({ err: retryError }, 'Error during fallback search-grounded generateContent call');
                return null;
            }
        }
        logger.error({ err: error }, 'Error during search-grounded generateContent call');
        return null;
    }
}

// --- Unified Response ---
export async function generateUnifiedResponse(contextPrompt, userQuery, options = {}) {
    if (!userQuery?.trim()) return null;
    const model = getGeminiClient();
    const thinkingLevel = options.thinkingLevel || 'high';
    const botLanguage = options.botLanguage || null;
    let unifiedSystemInstruction = CHAT_SAGE_SYSTEM_INSTRUCTION;
    if (botLanguage) {
        unifiedSystemInstruction += ` You MUST respond entirely in ${botLanguage}.`;
    }
    const fullPrompt = `${contextPrompt}\n\nUSER: ${userQuery}\nREPLY: ≤320 chars, direct.`;

    try {
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
            tools: searchTool,
            systemInstruction: { parts: [{ text: unifiedSystemInstruction }] },
            generationConfig: { responseMimeType: 'text/plain', thinkingConfig: { thinkingLevel } }
        });
        return safeExtractText(result, 'unified')?.trim() || null;
    } catch (err) {
        return null; // Silent fail
    }
}

// --- UPDATED: Summarize Text with Structured Output ---
const SummarySchema = {
    type: Type.OBJECT,
    properties: {
        summary: { type: Type.STRING }
    },
    required: ["summary"]
};

export async function summarizeText(textToSummarize, targetCharLength = 400, _options = {}) {
    if (!textToSummarize || typeof textToSummarize !== 'string' || !textToSummarize.trim()) return null;

    const prompt = `Summarize the following text in under ${targetCharLength} characters.
Text: ${textToSummarize}`;

    try {
        const responseText = await generateLiteContent(prompt, {
            ..._options,
            responseSchema: SummarySchema
        });

        if (responseText) {
            const parsed = JSON.parse(responseText);
            let summary = parsed.summary;
            if (summary) {
                if (summary.length > targetCharLength) {
                    const { smartTruncate } = await import('../llmUtils.js');
                    summary = smartTruncate(summary, targetCharLength);
                }
                return summary;
            }
        }
        return null;
    } catch (error) {
        logger.error({ err: error }, 'Error during summarization');
        return null;
    }
}
