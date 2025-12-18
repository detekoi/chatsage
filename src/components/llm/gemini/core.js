import { GoogleGenAI } from "@google/genai";
import logger from '../../../lib/logger.js';
import { retryWithBackoff } from './utils.js';

let genAI = null;
let generativeModel = null; // Wrapper that mirrors old API (generateContent/startChat)
let configuredModelId = null;

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
        logger.info(`Initializing Google GenAI with model: ${geminiConfig.modelId}`);
        configuredModelId = geminiConfig.modelId;
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
