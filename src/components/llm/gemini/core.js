import { GoogleGenAI } from "@google/genai";
import logger from '../../../lib/logger.js';
import { retryWithBackoff } from './utils.js';

let genAI = null;
let generativeModel = null; // Wrapper that mirrors old API (generateContent/startChat)
let configuredModelId = null;
let configuredLiteModelId = null;

/**
 * Initializes the GoogleGenerativeAI client and the specific model.
 */
export function initializeGeminiClient(geminiConfig) {
    if (genAI) {
        logger.warn('Gemini client already initialized.');
        return;
    }

    if (!geminiConfig || !geminiConfig.apiKey || !geminiConfig.modelId) {
        throw new Error('Missing required Gemini configuration (apiKey, modelId).');
    }

    try {
        logger.info(`Initializing Google GenAI with model: ${geminiConfig.modelId} (Lite: ${geminiConfig.liteModelId})`);
        configuredModelId = geminiConfig.modelId;
        configuredLiteModelId = geminiConfig.liteModelId || 'gemini-flash-lite-latest';
        genAI = new GoogleGenAI({ apiKey: geminiConfig.apiKey });

        // Wrapper provides an object-compatible API with previous code:
        // - generateContent(params) → ai.models.generateContent({ model, contents, config })
        // - startChat(options) → ai.chats.create({ model, config, history })
        generativeModel = {
            async generateContent(params) {
                return await retryWithBackoff(async () => {
                    const { generationConfig, systemInstruction, tools, toolConfig, ...rest } = params || {};
                    const config = {};
                    if (generationConfig && typeof generationConfig === 'object') Object.assign(config, generationConfig);
                    if (systemInstruction) config.systemInstruction = systemInstruction;
                    if (tools) config.tools = Array.isArray(tools) ? tools : [tools];
                    if (toolConfig) config.toolConfig = toolConfig;

                    return await genAI.models.generateContent({
                        model: params.model || configuredModelId,
                        ...rest,
                        ...(Object.keys(config).length > 0 ? { config } : {})
                    });
                }, 'generateContent');
            },
            startChat(options = {}) {
                const { systemInstruction, tools, generationConfig, history = [] } = options;
                const config = {};
                if (generationConfig && typeof generationConfig === 'object') Object.assign(config, generationConfig);
                if (systemInstruction) config.systemInstruction = systemInstruction;
                if (tools) config.tools = Array.isArray(tools) ? tools : [tools];
                const chat = genAI.chats.create({
                    model: configuredModelId,
                    ...(Object.keys(config).length > 0 ? { config } : {}),
                    history
                });

                // Wrap the sendMessage method with retry logic
                const originalSendMessage = chat.sendMessage.bind(chat);
                chat.sendMessage = async (message) => {
                    return await retryWithBackoff(
                        async () => await originalSendMessage(message),
                        'chat.sendMessage'
                    );
                };

                return chat;
            }
        };

        logger.info('Gemini client initialized successfully.');
    } catch (error) {
        logger.fatal({ err: { message: error.message, stack: error.stack, name: error.name } }, 'Failed to initialize GoogleGenerativeAI client.');
        genAI = null;
        generativeModel = null;
        configuredModelId = null;
        configuredLiteModelId = null;
        throw error;
    }
}

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

export function getConfiguredModelId() {
    return configuredModelId;
}



/**
 * One-shot generateContent call using the lightweight model.
 * Centralizes model selection, text extraction, and error handling.
 *
 * @param {string} prompt - The text prompt
 * @param {object} [options={}] - Optional config overrides
 * @param {string} [options.systemInstruction] - System instruction text
 * @param {object} [options.responseSchema] - JSON schema for structured output
 * @param {number} [options.temperature] - Temperature override
 * @param {Array} [options.multimodalParts] - Additional content parts (e.g. emote images)
 * @param {number} [options.maxOutputTokens] - Max tokens
 * @param {Array} [options.tools] - Tool declarations (e.g. [{ googleSearch: {} }] for grounding)
 * @returns {Promise<string|null>} Extracted text response, or null on failure
 */
export async function generateLiteContent(prompt, options = {}) {
    if (!genAI) throw new Error('Gemini client not initialized');

    const parts = [{ text: prompt }, ...(options.multimodalParts || [])];
    const config = {};

    if (options.systemInstruction) {
        config.systemInstruction = options.systemInstruction;
    }
    if (options.responseSchema) {
        config.responseMimeType = 'application/json';
        config.responseSchema = options.responseSchema;
    }
    if (options.temperature !== undefined) {
        config.temperature = options.temperature;
    }
    if (options.maxOutputTokens) {
        config.maxOutputTokens = options.maxOutputTokens;
    }
    if (options.tools) {
        config.tools = options.tools;
    }

    try {
        const result = await retryWithBackoff(async () => {
            return await genAI.models.generateContent({
                model: configuredLiteModelId,
                contents: [{ role: 'user', parts }],
                ...(Object.keys(config).length > 0 ? { config } : {})
            });
        }, 'generateLiteContent');
        const candidate = result?.candidates?.[0];
        if (candidate?.finishReason === 'SAFETY') {
            logger.warn('Content generation blocked due to SAFETY finishReason.');
            return null;
        }

        // Grounded responses can contain multiple parts (text + thought signatures),
        // so join all text parts rather than taking only the first.
        const joinedParts = candidate?.content?.parts?.filter(p => p.text).map(p => p.text).join('');
        return result?.text ?? (joinedParts || null);
    } catch (error) {
        logger.error({ err: error }, 'generateLiteContent failed');
        return null;
    }
}
