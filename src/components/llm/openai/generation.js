import logger from '../../../lib/logger.js';
import { getCurrentTime } from '../../../lib/timeUtils.js';
import { getOpenAiInstance, getConfiguredModelId, getConfiguredReasoningEffort, formatOpenAiContent } from './core.js';
import { safeExtractText, safeParseJsonResponse } from './utils.js';
import { buildSystemInstruction } from '../gemini/prompts.js';
import { standardAnswerTools, searchTool } from './tools.js';
import { TimezoneSchema, SummarySchema } from '../schemaUtils.js';
import { retryWithBackoff, executeWithFlexFallback } from '../retryUtils.js';
import { toOpenAiStrictSchema } from '../schemaUtils.js';

const strictTimezoneSchema = toOpenAiStrictSchema(TimezoneSchema);

/**
 * Uses the LLM to infer a valid IANA timezone for a given location string.
 */
export async function fetchIanaTimezoneForLocation(locationName) {
    if (!locationName || typeof locationName !== 'string' || locationName.trim().length === 0) {
        logger.error('fetchIanaTimezoneForLocation called with invalid locationName.');
        return null;
    }
    const openai = getOpenAiInstance();
    const model = getConfiguredModelId();

    const prompt = `What is the IANA timezone for "${locationName}"?
Examples: "New York" -> "America/New_York", "Tokyo" -> "Asia/Tokyo".
If unknown or ambiguous, return "UNKNOWN".
Return STRICT JSON.`;

    try {
        const response = await retryWithBackoff(async () => {
            return await openai.responses.create({
                model,
                input: prompt,
                text: {
                    format: {
                        type: 'json_schema',
                        name: 'timezone_response',
                        strict: true,
                        schema: strictTimezoneSchema
                    }
                }
            });
        }, 'fetchIanaTimezoneForLocation');

        const parsed = safeParseJsonResponse(response, '[Timezone]');
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


// Gemini callers pass thinkingLevel ('low'|'medium'|'high'); map it straight onto
// reasoning effort, falling back to the configured default.
function resolveReasoningEffort(options = {}) {
    return options.reasoningEffort || options.thinkingLevel || getConfiguredReasoningEffort();
}

// Support function calls for getCurrentTime and get_iana_timezone_for_location_tool
async function handleFunctionCall(functionCall) {
    if (!functionCall || !functionCall.name) return null;

    let args;
    try {
        args = typeof functionCall.arguments === 'string' ? JSON.parse(functionCall.arguments) : (functionCall.arguments || {});
    } catch (_) {
        args = {};
    }

    if (functionCall.name === 'getCurrentTime') {
        return getCurrentTime(args);
    }
    if (functionCall.name === 'get_iana_timezone_for_location_tool') {
        const location = args.location_name;
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
    const openai = getOpenAiInstance();
    const model = getConfiguredModelId();
    const reasoningEffort = resolveReasoningEffort(options);
    const botLanguage = options.botLanguage || null;

    let standardSystemInstruction = `${buildSystemInstruction(options.channelName)}\n\nTOOL USE GUIDELINES:\n- You have access to a 'getCurrentTime' tool. Use it ONLY if the user explicitly asks for the current time or date.\n- Do NOT use 'getCurrentTime' for general facts.`;
    if (botLanguage) {
        standardSystemInstruction += `\n\nCRITICAL LANGUAGE REQUIREMENT: You MUST write every response entirely in ${botLanguage}, even though the stream context and chat history are in another language.`;
    }
    const fullPrompt = `${contextPrompt}\n\nUSER: ${userQuery}\nREPLY: ≤300 chars. Answer directly.`;
    const emoteImageParts = options.emoteImageParts || [];

    const contentParts = formatOpenAiContent(fullPrompt, emoteImageParts);
    const inputPayload = contentParts.length === 1 && contentParts[0].type === 'input_text'
        ? contentParts[0].text
        : [{ role: 'user', content: contentParts }];

    try {
        const initialResponse = await executeWithFlexFallback(
            (payload, reqOpts) => openai.responses.create(payload, reqOpts),
            {
                model,
                input: inputPayload,
                instructions: standardSystemInstruction,
                tools: standardAnswerTools,
                reasoning: { effort: reasoningEffort }
            },
            options,
            'generateStandardResponse'
        );

        // Check for function call in response.output
        const toolCalls = initialResponse.output?.filter(item => item.type === 'function_call') || [];
        if (toolCalls.length > 0) {
            const call = toolCalls[0];
            const functionResult = await handleFunctionCall(call);

            if (functionResult) {
                const followupResponse = await executeWithFlexFallback(
                    (payload, reqOpts) => openai.responses.create(payload, reqOpts),
                    {
                        model,
                        previous_response_id: initialResponse.id,
                        instructions: standardSystemInstruction,
                        tools: standardAnswerTools,
                        input: [{
                            type: 'function_call_output',
                            call_id: call.call_id,
                            output: JSON.stringify(functionResult)
                        }],
                        reasoning: { effort: reasoningEffort }
                    },
                    options,
                    'generateStandardResponse.followup'
                );

                const followupText = safeExtractText(followupResponse, 'standard-followup');
                return followupText?.trim() || null;
            }
        }

        const responseText = safeExtractText(initialResponse, 'standard');
        return responseText?.trim() || null;
    } catch (error) {
        logger.error({ err: error }, 'Error during standard generateContent call');
        return null;
    }
}

// --- Search Response ---
// A function rather than a module constant: the persona layer is per-channel now,
// so this cannot be resolved once at import time.
const buildSearchSystemInstruction = (channelName) => `${buildSystemInstruction(channelName)}

CRITICAL FOR !search COMMAND: Your training knowledge about world events, product releases, announcements, and anything time-sensitive is UNRELIABLE and likely OUTDATED. You MUST use the web search tool to fetch current, real-world information before answering. Do NOT answer from memory for any factual or recent-events query — always search first, then answer based on what you find.`;

export async function generateSearchResponse(contextPrompt, userQuery, options = {}) {
    if (!userQuery?.trim()) return null;
    const openai = getOpenAiInstance();
    const model = getConfiguredModelId();
    const reasoningEffort = resolveReasoningEffort(options);
    const botLanguage = options.botLanguage || null;

    let searchSystemInstruction = buildSearchSystemInstruction(options.channelName);
    if (botLanguage) {
        searchSystemInstruction += `\n\nCRITICAL LANGUAGE REQUIREMENT: You MUST write every response entirely in ${botLanguage}, even though the stream context and chat history are in another language.`;
    }
    const fullPrompt = `${contextPrompt}\n\nUSER: ${userQuery}\nSearch the web right now and answer based on current results. Response ≤ 420 chars.`;
    const emoteImageParts = options.emoteImageParts || [];

    const buildRequest = (parts) => {
        const contentParts = formatOpenAiContent(fullPrompt, parts);
        const inputPayload = contentParts.length === 1 && contentParts[0].type === 'input_text'
            ? contentParts[0].text
            : [{ role: 'user', content: contentParts }];
        return {
            model,
            input: inputPayload,
            instructions: searchSystemInstruction,
            tools: searchTool,
            reasoning: { effort: reasoningEffort }
        };
    };

    const processResponse = (response) => {
        const webSearchCalls = response.output?.filter(item => item.type === 'web_search_call') || [];
        const usedSearch = webSearchCalls.length > 0;
        const sources = [];

        // Collect URL citations — they live in message content parts' annotations
        if (Array.isArray(response.output)) {
            for (const item of response.output) {
                if (item.type !== 'message' || !Array.isArray(item.content)) continue;
                for (const part of item.content) {
                    for (const annotation of part.annotations || []) {
                        if (annotation.type === 'url_citation' && annotation.url) {
                            sources.push(annotation.url);
                        }
                    }
                }
            }
        }

        if (usedSearch) {
            logger.info({ usedGoogleSearch: true, webSearchQueries: webSearchCalls.map(c => c.query || ''), sources: sources.slice(0, 3) }, '[SearchResponse] Search grounded.');
        } else {
            logger.info({ usedGoogleSearch: false }, '[SearchResponse] No search grounding metadata present.');
        }

        return safeExtractText(response, 'search')?.trim() || null;
    };

    try {
        const result = await retryWithBackoff(async () => {
            return await openai.responses.create(buildRequest(emoteImageParts));
        }, 'generateSearchResponse');

        return processResponse(result);
    } catch (error) {
        if (emoteImageParts.length > 0) {
            logger.warn({ err: error }, 'Search request with multimodal emotes failed. Retrying without image parts.');
            try {
                const result = await retryWithBackoff(async () => {
                    return await openai.responses.create(buildRequest([]));
                }, 'generateSearchResponse.fallback');
                return processResponse(result);
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
    const openai = getOpenAiInstance();
    const model = getConfiguredModelId();
    const reasoningEffort = resolveReasoningEffort(options);
    const botLanguage = options.botLanguage || null;

    let unifiedSystemInstruction = buildSystemInstruction(options.channelName);
    if (botLanguage) {
        unifiedSystemInstruction += `\n\nCRITICAL LANGUAGE REQUIREMENT: You MUST write every response entirely in ${botLanguage}, even though the stream context and chat history are in another language.`;
    }
    const fullPrompt = `${contextPrompt}\n\nUSER: ${userQuery}\nREPLY: ≤320 chars, direct.`;

    try {
        const response = await retryWithBackoff(async () => {
            return await openai.responses.create({
                model,
                input: fullPrompt,
                instructions: unifiedSystemInstruction,
                tools: searchTool,
                reasoning: { effort: reasoningEffort }
            });
        }, 'generateUnifiedResponse');

        return safeExtractText(response, 'unified')?.trim() || null;
    } catch (err) {
        return null;
    }
}

// --- Summarize Text ---
export async function summarizeText(textToSummarize, targetCharLength = 400, _options = {}) {
    if (!textToSummarize || typeof textToSummarize !== 'string' || !textToSummarize.trim()) return null;

    const prompt = `Summarize the following text in under ${targetCharLength} characters.
Text: ${textToSummarize}`;

    try {
        const { generateLiteContent } = await import('./core.js');
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
