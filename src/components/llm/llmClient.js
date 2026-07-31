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
    multimodalParts,
    returnMeta = false
}) {
    if (isOpenAi()) {
        // Pass the plain schema through — openai/core.js applies the strict
        // conversion exactly once.
        const { text, response } = await openAiCore.generateLiteContentWithResponse(prompt, {
            systemInstruction,
            responseSchema: schema,
            schemaName,
            temperature,
            modelId: model === 'lite' ? config.openai.liteModelId : config.openai.modelId,
            reasoningEffort: model === 'lite' ? undefined : config.openai.reasoningEffort,
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

        const parsed = geminiUtils.safeParseJsonResponse(result, `[StructuredJson:${schemaName}]`);
        if (returnMeta) {
            const searchUsed = !!(result?.candidates?.[0]?.groundingMetadata?.webSearchQueries?.length);
            return { parsed, searchUsed };
        }
        return parsed;
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
            reasoningEffort: model === 'lite' ? undefined : config.openai.reasoningEffort,
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

    const text = geminiUtils.safeExtractText(result, '[GenerateText]');
    if (!text) {
        const candidate = result?.candidates?.[0];
        logger.warn({
            finishReason: candidate?.finishReason,
            hasCandidates: !!result?.candidates?.length,
            partsLength: candidate?.content?.parts?.length ?? 0,
            promptFeedback: result?.promptFeedback
        }, '[GenerateText] Text extraction failed — response diagnostics attached.');
    }
    return text;
}

/**
 * Image description helper normalizing inlineData vs input_image across providers.
 * `thinkingLevel` maps to Gemini thinkingConfig / OpenAI reasoning effort;
 * `temperature` applies on Gemini only (unsupported by OpenAI reasoning models).
 */
export async function describeImages({ parts, prompt, systemInstruction, modelId, temperature, maxOutputTokens, thinkingLevel }) {
    if (isOpenAi()) {
        const responseText = await openAiCore.generateLiteContent(prompt, {
            systemInstruction,
            multimodalParts: parts,
            modelId: modelId || config.openai.modelId,
            maxOutputTokens,
            ...(thinkingLevel ? { reasoningEffort: thinkingLevel } : {})
        });
        return responseText;
    } else {
        const geminiModel = geminiCore.getGeminiClient();
        const contents = [{ role: 'user', parts: [...(parts || []), { text: prompt }] }];
        const genConfig = {};
        if (temperature !== undefined) genConfig.temperature = temperature;
        if (maxOutputTokens) genConfig.maxOutputTokens = maxOutputTokens;
        if (thinkingLevel) genConfig.thinkingConfig = { thinkingLevel };
        const result = await geminiModel.generateContent({
            model: modelId || config.gemini.modelId,
            contents,
            ...(systemInstruction ? { systemInstruction } : {}),
            ...(Object.keys(genConfig).length > 0 ? { generationConfig: genConfig } : {})
        });
        return geminiUtils.safeExtractText(result, '[DescribeImages]');
    }
}
