import config from '../../config/loader.js';
import logger from '../../lib/logger.js';

import * as geminiCore from './gemini/core.js';
import * as geminiChat from './gemini/chat.js';
import * as geminiGen from './gemini/generation.js';
import * as geminiDec from './gemini/decision.js';
import * as geminiUtils from './gemini/utils.js';

import * as openAiCore from './openai/core.js';
import * as openAiChat from './openai/chat.js';
import * as openAiGen from './openai/generation.js';
import * as openAiDec from './openai/decision.js';
import * as openAiUtils from './openai/utils.js';

import { toGeminiSchema } from './schemaUtils.js';

export { buildContextPrompt } from './gemini/prompts.js';

/**
 * Initializes BOTH LLM clients for the 2-model routing architecture.
 * Both providers are required — missing either key is a fatal startup error.
 *
 * - Gemini Flash Lite: Translation, summarization, botlang detection, emote description
 * - OpenAI Luna: All other functionalities (ask, search, games, check-ins, commands)
 */
export function initializeLlmClient(appConfig = config) {
    const openaiConfig = appConfig.openai || config.openai;
    const geminiConfig = appConfig.gemini || appConfig;

    // Fail-fast: both providers are required for the 2-model architecture.
    if (!openaiConfig?.apiKey) {
        throw new Error('OPENAI_API_KEY is required for 2-model routing (Primary tier). Set it in environment variables.');
    }
    if (!geminiConfig?.apiKey) {
        throw new Error('GEMINI_API_KEY is required for 2-model routing (Speed tier). Set it in environment variables.');
    }

    logger.info('Initializing OpenAI client (Primary tier: gpt-5.6-luna)');
    openAiCore.initializeOpenAiClient(openaiConfig);

    logger.info('Initializing Gemini client (Speed tier: gemini-flash-lite-latest)');
    geminiCore.initializeGeminiClient(geminiConfig);
}

export function initializeGeminiClient(configOrGeminiConfig) {
    return initializeLlmClient(configOrGeminiConfig);
}

export function getGenAIInstance() {
    return geminiCore.getGenAIInstance();
}

export function getGeminiClient() {
    return geminiCore.getGeminiClient();
}

/**
 * One-shot generation helper.
 * By default (no model option or model='lite'), routes to Gemini Flash Lite for speed (~360ms).
 * If model='main', routes to OpenAI Luna for personality & quality (~1s),
 * explicitly setting modelId and reasoningEffort to main-tier values.
 */
export function generateLiteContent(prompt, options = {}) {
    if (options.model === 'main' || options.provider === 'openai') {
        return openAiCore.generateLiteContent(prompt, {
            ...options,
            modelId: options.modelId || config.openai.modelId,
            reasoningEffort: options.reasoningEffort || config.openai.reasoningEffort,
        });
    }
    return geminiCore.generateLiteContent(prompt, options);
}

export function getOrCreateChatSession(channelName, initialContext = null, chatHistory = null, botLanguage = null) {
    return openAiChat.getOrCreateChatSession(channelName, initialContext, chatHistory, botLanguage);
}

export function resetChatSession(channelName) {
    return openAiChat.resetChatSession(channelName);
}

export function clearChatSession(channelOrSessionId) {
    return openAiChat.clearChatSession(channelOrSessionId);
}

export function generateStandardResponse(contextPrompt, userQuery, options = {}) {
    return openAiGen.generateStandardResponse(contextPrompt, userQuery, options);
}

export function generateSearchResponse(contextPrompt, userQuery, options = {}) {
    return openAiGen.generateSearchResponse(contextPrompt, userQuery, options);
}

export function generateUnifiedResponse(contextPrompt, userQuery, options = {}) {
    return openAiGen.generateUnifiedResponse(contextPrompt, userQuery, options);
}

export function summarizeText(textToSummarize, targetCharLength = 400, options = {}) {
    return geminiGen.summarizeText(textToSummarize, targetCharLength, options);
}

export function fetchIanaTimezoneForLocation(locationName) {
    return openAiGen.fetchIanaTimezoneForLocation(locationName);
}

export function decideSearchWithStructuredOutput(contextPrompt, userQuery) {
    return openAiDec.decideSearchWithStructuredOutput(contextPrompt, userQuery);
}

// safeExtractText / safeParseJsonResponse are re-exported for backward compatibility
// via geminiClient.js, but no production caller imports them from this facade.
// All real callers use the provider-specific utils directly.
// Delegate to Gemini utils since that's the only provider that returns raw
// result objects through generateLiteContent (OpenAI paths extract text internally).
export function safeExtractText(result, logContext = 'llm') {
    return geminiUtils.safeExtractText(result, logContext);
}

export function safeParseJsonResponse(result, logContext = 'llm') {
    return geminiUtils.safeParseJsonResponse(result, logContext);
}

// --- Provider-Agnostic Facade Helpers ---

/**
 * Generates structured JSON output using standard JSON schemas.
 * Main model defaults to OpenAI Luna; lite model routes to Gemini Flash Lite.
 */
export async function generateStructuredJson({
    prompt,
    schema,
    schemaName = 'structured_output',
    systemInstruction,
    temperature,
    model = 'main',
    tools,
    multimodalParts,
    returnMeta = false
}) {
    if (model === 'lite') {
        const geminiModel = geminiCore.getGeminiClient();
        const geminiSchema = toGeminiSchema(schema);
        const parts = [{ text: prompt }, ...(multimodalParts || [])];
        const genConfig = {
            responseMimeType: 'application/json',
            responseSchema: geminiSchema
        };
        if (temperature !== undefined) genConfig.temperature = temperature;

        const result = await geminiModel.generateContent({
            model: config.gemini.liteModelId,
            contents: [{ role: 'user', parts }],
            ...(systemInstruction ? { systemInstruction } : {}),
            ...(tools ? { tools } : {}),
            generationConfig: genConfig
        });

        const parsed = geminiUtils.safeParseJsonResponse(result, `[StructuredJson:${schemaName}]`);
        if (returnMeta) {
            const searchUsed = !!(result?.candidates?.[0]?.groundingMetadata?.webSearchQueries?.length);
            return { parsed, searchUsed };
        }
        return parsed;
    } else {
        const { text, response } = await openAiCore.generateLiteContentWithResponse(prompt, {
            systemInstruction,
            responseSchema: schema,
            schemaName,
            temperature,
            modelId: config.openai.modelId,
            reasoningEffort: config.openai.reasoningEffort,
            tools,
            multimodalParts
        });
        let parsed = null;
        if (text) {
            try {
                parsed = JSON.parse(text);
            } catch (e) {
                logger.warn({ err: e, text }, 'Failed to parse structured JSON response in facade');
            }
        }
        if (returnMeta) {
            const searchUsed = !!response?.output?.some(item => item.type === 'web_search_call');
            return { parsed, searchUsed };
        }
        return parsed;
    }
}

/**
 * Plain-text generation helper.
 * options.model === 'lite' -> Gemini Flash Lite
 * options.model === 'main' (default) -> OpenAI Luna
 */
export async function generateText(prompt, {
    systemInstruction,
    temperature,
    maxOutputTokens,
    webSearch = false,
    model = 'main',
    multimodalParts
} = {}) {
    if (model === 'lite') {
        return geminiCore.generateLiteContent(prompt, {
            systemInstruction,
            temperature,
            maxOutputTokens,
            multimodalParts,
            ...(webSearch ? { tools: [{ googleSearch: {} }] } : {})
        });
    }

    return openAiCore.generateLiteContent(prompt, {
        systemInstruction,
        maxOutputTokens,
        multimodalParts,
        modelId: config.openai.modelId,
        reasoningEffort: config.openai.reasoningEffort,
        ...(webSearch ? { tools: [{ type: 'web_search' }] } : {})
    });
}

/**
 * Image description via OpenAI Luna.
 * Note: `temperature` is intentionally NOT accepted — OpenAI reasoning models
 * control sampling via reasoningEffort, not temperature. Callers that previously
 * passed temperature should use thinkingLevel (mapped to reasoningEffort) instead.
 */
export async function describeImages({ parts, prompt, systemInstruction, modelId, maxOutputTokens, thinkingLevel }) {
    const responseText = await openAiCore.generateLiteContent(prompt, {
        systemInstruction,
        multimodalParts: parts,
        modelId: modelId || config.openai.modelId,
        maxOutputTokens,
        ...(thinkingLevel ? { reasoningEffort: thinkingLevel } : {})
    });
    return responseText;
}
