import { Type } from "@google/genai";
import logger from '../../../lib/logger.js';
import { getCurrentTime } from '../../../lib/timeUtils.js';
import { getGeminiClient, getGenAIInstance, getConfiguredModelId } from './core.js';
import { extractTextFromResponse, sleep } from './utils.js';
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
    const ai = getGenAIInstance();
    const modelId = process.env.GEMINI_MODEL_ID || getConfiguredModelId() || 'gemini-2.5-flash';

    const prompt = `What is the IANA timezone for "${locationName}"?
Examples: "New York" -> "America/New_York", "Tokyo" -> "Asia/Tokyo".
If unknown or ambiguous, return "UNKNOWN".
Return STRICT JSON.`;

    try {
        const result = await ai.models.generateContent({
            model: modelId,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
                temperature: 0.0,
                responseMimeType: 'application/json',
                responseSchema: TimezoneSchema
            }
        });

        const responseText = result.candidates?.[0]?.content?.parts?.[0]?.text;
        if (responseText) {
            const parsed = JSON.parse(responseText);
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

// --- Standard Response (mostly unchanged, just import/export management) ---

// --- Standard Response Schema ---
const StandardResponseSchema = {
    type: Type.OBJECT,
    properties: {
        text: { type: Type.STRING, description: "The response text to be sent to chat." }
    },
    required: ["text"]
};

// --- Standard Response ---
export async function generateStandardResponse(contextPrompt, userQuery, options = {}) {
    const model = getGeminiClient();
    const thinkingLevel = options.thinkingLevel || 'high';
    const standardSystemInstruction = `${CHAT_SAGE_SYSTEM_INSTRUCTION}\n\nTOOL USE GUIDELINES:\n- You have access to a 'getCurrentTime' tool. Use it ONLY if the user explicitly asks for the current time or date.\n- Do NOT use 'getCurrentTime' for general facts.`;
    const fullPrompt = `${contextPrompt}\n\nUSER: ${userQuery}\nREPLY: ≤300 chars. Answer directly.`;

    try {
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
            tools: [standardAnswerTools],
            toolConfig: { functionCallingConfig: { mode: "AUTO" } },
            systemInstruction: { parts: [{ text: standardSystemInstruction }] },
            generationConfig: {
                responseMimeType: 'application/json',
                responseSchema: StandardResponseSchema,
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
                    { role: "function", parts: [{ functionResponse: { name: functionCall.name, response: functionResult } }] }
                ];
                const followup = await model.generateContent({
                    contents: history,
                    tools: [standardAnswerTools],
                    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
                    systemInstruction: { parts: [{ text: standardSystemInstruction }] },
                    generationConfig: {
                        responseMimeType: 'application/json',
                        responseSchema: StandardResponseSchema,
                        thinkingConfig: { thinkingLevel }
                    }
                });

                // For followup, we also expect JSON now
                const rawJson = extractTextFromResponse(followup, followup.candidates?.[0], 'standard-followup');
                try {
                    if (rawJson) {
                        const parsed = JSON.parse(rawJson);
                        return parsed.text || null;
                    }
                } catch (e) {
                    logger.warn({ err: e, rawJson }, 'Failed to parse structured output from standard followup');
                }
                return null;
            }
        }

        // Extract text from the response - it should be a JSON string now
        const rawJsonText = extractTextFromResponse(response, candidate, 'standard');

        if (rawJsonText) {
            try {
                const parsed = JSON.parse(rawJsonText);
                return parsed.text || null;
            } catch (e) {
                logger.warn({ err: e, rawJsonText }, 'Failed to parse structured output from standard response');
                // Fallback: if it's not valid JSON, maybe the model ignored instructions and just sent text?
                // In a strict schema world, this is an error, but for robustness we could return the raw text if it doesn't look like JSON.
                // However, the goal is *single source of truth*. If it fails schema, it fails.
                return null;
            }
        }

        return null;
    } catch (error) {
        logger.error({ err: error }, 'Error during standard generateContent call');
        return null;
    }
}

// --- Search Response ---
export async function generateSearchResponse(contextPrompt, userQuery, options = {}) {
    if (!userQuery?.trim()) return null;
    const model = getGeminiClient();
    const thinkingLevel = options.thinkingLevel || 'high';
    const fullPrompt = `${contextPrompt}\n\nUSER: ${userQuery}\nIMPORTANT: Search the web. Response ≤ 420 chars.`;

    try {
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
            tools: searchTool,
            systemInstruction: { parts: [{ text: CHAT_SAGE_SYSTEM_INSTRUCTION }] },
            generationConfig: { responseMimeType: 'text/plain', thinkingConfig: { thinkingLevel } }
        });

        const candidate = result.candidates?.[0];
        // Logging for grounding (simplified)
        if (candidate?.groundingMetadata) {
            logger.info({ queries: candidate.groundingMetadata.webSearchQueries }, 'Search grounded.');
        }
        return extractTextFromResponse(result, candidate, 'search')?.trim() || null;
    } catch (error) {
        logger.error({ err: error }, 'Error during search-grounded generateContent call');
        return null;
    }
}

// --- Unified Response ---
export async function generateUnifiedResponse(contextPrompt, userQuery, options = {}) {
    if (!userQuery?.trim()) return null;
    const model = getGeminiClient();
    const thinkingLevel = options.thinkingLevel || 'high';
    const fullPrompt = `${contextPrompt}\n\nUSER: ${userQuery}\nREPLY: ≤320 chars, direct.`;

    try {
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
            tools: [{ googleSearch: {} }],
            systemInstruction: { parts: [{ text: CHAT_SAGE_SYSTEM_INSTRUCTION }] },
            generationConfig: { responseMimeType: 'text/plain', thinkingConfig: { thinkingLevel } }
        });
        return extractTextFromResponse(result, result.candidates?.[0], 'unified')?.trim() || null;
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

export async function summarizeText(textToSummarize, targetCharLength = 400, options = {}) {
    if (!textToSummarize || typeof textToSummarize !== 'string' || !textToSummarize.trim()) return null;
    const ai = getGenAIInstance();
    const modelId = process.env.GEMINI_MODEL_ID || getConfiguredModelId() || 'gemini-2.5-flash-lite';

    const prompt = `Summarize the following text in under ${targetCharLength} characters.
Text: ${textToSummarize}
Return STRICT JSON.`;

    try {
        // Simplified retry loop
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const result = await ai.models.generateContent({
                    model: modelId,
                    contents: [{ role: "user", parts: [{ text: prompt }] }],
                    config: {
                        responseMimeType: 'application/json',
                        responseSchema: SummarySchema,
                        temperature: 0.3,
                        thinkingConfig: { thinkingLevel: options.thinkingLevel || 'high' }
                    }
                });

                const responseText = result.candidates?.[0]?.content?.parts?.[0]?.text;
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
                break; // Stop if we got a response but it wasn't valid, don't spam retry
            } catch (error) {
                if (attempt === 2) throw error;
                await sleep(500 * Math.pow(2, attempt));
            }
        }
        return null;
    } catch (error) {
        logger.error({ err: error }, 'Error during summarization');
        return null;
    }
}
