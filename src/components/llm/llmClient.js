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

import { toGeminiSchema, toOpenAiStrictSchema } from './schemaUtils.js';

export { buildContextPrompt } from './gemini/prompts.js';

/**
 * Initializes the LLM client based on config.llm.provider.
 * Backwards-compatible signature accepts either full config object or gemini config.
 */
export function initializeLlmClient(appConfig = config) {
    const provider = (appConfig.llm?.provider || config.llm?.provider || 'gemini').toLowerCase();

    if (provider === 'openai') {
        logger.info('Initializing LLM Client with provider: OpenAI');
        const openaiConfig = appConfig.openai || config.openai;
        openAiCore.initializeOpenAiClient(openaiConfig);
    } else {
        logger.info('Initializing LLM Client with provider: Gemini');
        const geminiConfig = appConfig.gemini || appConfig;
        geminiCore.initializeGeminiClient(geminiConfig);
    }
}

export function initializeGeminiClient(configOrGeminiConfig) {
    return initializeLlmClient(configOrGeminiConfig);
}

function isOpenAi() {
    return (config.llm?.provider || 'gemini').toLowerCase() === 'openai';
}

export function getGenAIInstance() {
    if (isOpenAi()) {
        return openAiCore.getOpenAiInstance();
    }
    return geminiCore.getGenAIInstance();
}

// Gemini-only legacy accessor. Callers needing provider-agnostic generation
// must use generateText / generateStructuredJson / describeImages instead.
export function getGeminiClient() {
    return geminiCore.getGeminiClient();
}

export function generateLiteContent(prompt, options = {}) {
    if (isOpenAi()) {
        return openAiCore.generateLiteContent(prompt, options);
    }
    return geminiCore.generateLiteContent(prompt, options);
}

export function getOrCreateChatSession(channelName, initialContext = null, chatHistory = null, botLanguage = null) {
    if (isOpenAi()) {
        return openAiChat.getOrCreateChatSession(channelName, initialContext, chatHistory, botLanguage);
    }
    return geminiChat.getOrCreateChatSession(channelName, initialContext, chatHistory, botLanguage);
}

export function resetChatSession(channelName) {
    if (isOpenAi()) {
        return openAiChat.resetChatSession(channelName);
    }
    return geminiChat.resetChatSession(channelName);
}

export function clearChatSession(channelOrSessionId) {
    if (isOpenAi()) {
        return openAiChat.clearChatSession(channelOrSessionId);
    }
    return geminiChat.clearChatSession(channelOrSessionId);
}

export function generateStandardResponse(contextPrompt, userQuery, options = {}) {
    if (isOpenAi()) {
        return openAiGen.generateStandardResponse(contextPrompt, userQuery, options);
    }
    return geminiGen.generateStandardResponse(contextPrompt, userQuery, options);
}

export function generateSearchResponse(contextPrompt, userQuery, options = {}) {
    if (isOpenAi()) {
        return openAiGen.generateSearchResponse(contextPrompt, userQuery, options);
    }
    return geminiGen.generateSearchResponse(contextPrompt, userQuery, options);
}

export function generateUnifiedResponse(contextPrompt, userQuery, options = {}) {
    if (isOpenAi()) {
        return openAiGen.generateUnifiedResponse(contextPrompt, userQuery, options);
    }
    return geminiGen.generateUnifiedResponse(contextPrompt, userQuery, options);
}

export function summarizeText(textToSummarize, targetCharLength = 400, options = {}) {
    if (isOpenAi()) {
        return openAiGen.summarizeText(textToSummarize, targetCharLength, options);
    }
    return geminiGen.summarizeText(textToSummarize, targetCharLength, options);
}

export function fetchIanaTimezoneForLocation(locationName) {
    if (isOpenAi()) {
        return openAiGen.fetchIanaTimezoneForLocation(locationName);
    }
    return geminiGen.fetchIanaTimezoneForLocation(locationName);
}

export function decideSearchWithStructuredOutput(contextPrompt, userQuery) {
    if (isOpenAi()) {
        return openAiDec.decideSearchWithStructuredOutput(contextPrompt, userQuery);
    }
    return geminiDec.decideSearchWithStructuredOutput(contextPrompt, userQuery);
}

export function safeExtractText(result, logContext = 'llm') {
    if (isOpenAi()) {
        return openAiUtils.safeExtractText(result, logContext);
    }
    return geminiUtils.safeExtractText(result, logContext);
}

export function safeParseJsonResponse(result, logContext = 'llm') {
    if (isOpenAi()) {
        return openAiUtils.safeParseJsonResponse(result, logContext);
    }
    return geminiUtils.safeParseJsonResponse(result, logContext);
}

// --- Provider-Agnostic Facade Helpers ---

/**
 * Generates structured JSON output using standard JSON schemas.
 */
export async function generateStructuredJson({
    prompt,
    schema,
    schemaName = 'structured_output',
    systemInstruction,
    temperature,
    model = 'main',
    tools,
    multimodalParts
}) {
    if (isOpenAi()) {
        const strictSchema = toOpenAiStrictSchema(schema);
        const responseText = await openAiCore.generateLiteContent(prompt, {
            systemInstruction,
            responseSchema: strictSchema,
            schemaName,
            temperature,
            modelId: model === 'lite' ? config.openai.liteModelId : config.openai.modelId,
            tools,
            multimodalParts
        });
        if (!responseText) return null;
        try {
            return JSON.parse(responseText);
        } catch (e) {
            logger.warn({ err: e, text: responseText }, 'Failed to parse structured JSON response in facade');
            return null;
        }
    } else {
        const geminiModel = geminiCore.getGeminiClient();
        const geminiSchema = toGeminiSchema(schema);
        const parts = [{ text: prompt }, ...(multimodalParts || [])];
        const genConfig = {
            responseMimeType: 'application/json',
            responseSchema: geminiSchema
        };
        if (temperature !== undefined) genConfig.temperature = temperature;

        const result = await geminiModel.generateContent({
            model: model === 'lite' ? config.gemini.liteModelId : config.gemini.modelId,
            contents: [{ role: 'user', parts }],
            ...(systemInstruction ? { systemInstruction } : {}),
            ...(tools ? { tools } : {}),
            generationConfig: genConfig
        });

        return geminiUtils.safeParseJsonResponse(result, `[StructuredJson:${schemaName}]`);
    }
}

/**
 * Provider-agnostic plain-text generation on the main (or lite) model.
 * @param {string} prompt
 * @param {object} [options]
 * @param {string} [options.systemInstruction]
 * @param {number} [options.temperature] - Applied on Gemini only (unsupported by OpenAI reasoning models)
 * @param {number} [options.maxOutputTokens]
 * @param {boolean} [options.webSearch] - Enable the provider's web search tool
 * @param {'main'|'lite'} [options.model='main']
 * @param {Array} [options.multimodalParts] - Gemini-style parts ({text}/{inlineData})
 * @returns {Promise<string|null>}
 */
export async function generateText(prompt, {
    systemInstruction,
    temperature,
    maxOutputTokens,
    webSearch = false,
    model = 'main',
    multimodalParts
} = {}) {
    if (isOpenAi()) {
        return openAiCore.generateLiteContent(prompt, {
            systemInstruction,
            maxOutputTokens,
            multimodalParts,
            modelId: model === 'lite' ? config.openai.liteModelId : config.openai.modelId,
            ...(webSearch ? { tools: [{ type: 'web_search' }] } : {})
        });
    }

    const geminiModel = geminiCore.getGeminiClient();
    const parts = [{ text: prompt }, ...(multimodalParts || [])];
    const genConfig = {};
    if (temperature !== undefined) genConfig.temperature = temperature;
    if (maxOutputTokens) genConfig.maxOutputTokens = maxOutputTokens;

    const result = await geminiModel.generateContent({
        model: model === 'lite' ? config.gemini.liteModelId : config.gemini.modelId,
        contents: [{ role: 'user', parts }],
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(webSearch ? { tools: [{ googleSearch: {} }] } : {}),
        ...(Object.keys(genConfig).length > 0 ? { generationConfig: genConfig } : {})
    });

    return geminiUtils.safeExtractText(result, '[GenerateText]');
}

/**
 * Image description helper normalizing inlineData vs input_image across providers.
 */
export async function describeImages({ parts, prompt, systemInstruction, modelId }) {
    if (isOpenAi()) {
        const responseText = await openAiCore.generateLiteContent(prompt, {
            systemInstruction,
            multimodalParts: parts,
            modelId: modelId || config.openai.modelId
        });
        return responseText;
    } else {
        const geminiModel = geminiCore.getGeminiClient();
        const contents = [{ role: 'user', parts: [...(parts || []), { text: prompt }] }];
        const result = await geminiModel.generateContent({
            model: modelId || config.gemini.modelId,
            contents,
            ...(systemInstruction ? { systemInstruction } : {})
        });
        return geminiUtils.safeExtractText(result, '[DescribeImages]');
    }
}
