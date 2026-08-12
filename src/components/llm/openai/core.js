import OpenAI from 'openai';
import logger from '../../../lib/logger.js';
import { executeWithFlexFallback } from '../retryUtils.js';
import { toOpenAiStrictSchema } from '../schemaUtils.js';
import { extractRefusal } from './utils.js';

let openaiClient = null;
let configuredModelId = null;
let configuredLiteModelId = null;
let configuredReasoningEffort = null;
let configuredLiteReasoningEffort = null;

/**
 * Initializes the OpenAI client and model parameters.
 */
export function initializeOpenAiClient(openaiConfig) {
    if (openaiClient) {
        logger.warn('OpenAI client already initialized.');
        return;
    }

    if (!openaiConfig || !openaiConfig.apiKey) {
        throw new Error('Missing required OpenAI configuration (apiKey).');
    }

    try {
        configuredModelId = openaiConfig.modelId || 'gpt-5.6-luna';
        configuredLiteModelId = openaiConfig.liteModelId || 'gpt-5.6-luna';
        configuredReasoningEffort = openaiConfig.reasoningEffort || 'low';
        configuredLiteReasoningEffort = openaiConfig.liteReasoningEffort || 'minimal';

        logger.info(`Initializing OpenAI client with model: ${configuredModelId} (Lite: ${configuredLiteModelId})`);

        openaiClient = new OpenAI({ apiKey: openaiConfig.apiKey });
        logger.info('OpenAI client initialized successfully.');
    } catch (error) {
        logger.fatal({ err: { message: error.message, stack: error.stack } }, 'Failed to initialize OpenAI client.');
        openaiClient = null;
        configuredModelId = null;
        configuredLiteModelId = null;
        throw error;
    }
}

export function getOpenAiInstance() {
    if (!openaiClient) {
        throw new Error('OpenAI client has not been initialized. Call initializeOpenAiClient first.');
    }
    return openaiClient;
}

export function getConfiguredModelId() {
    return configuredModelId;
}

export function getConfiguredReasoningEffort() {
    return configuredReasoningEffort || 'low';
}

/**
 * Normalizes multimodal parts (inlineData / input_image / text) into OpenAI content array format.
 */

export function formatOpenAiContent(promptText, multimodalParts = []) {
    const content = [];

    if (promptText) {
        content.push({ type: 'input_text', text: promptText });
    }

    if (Array.isArray(multimodalParts)) {
        for (const part of multimodalParts) {
            if (part.text) {
                content.push({ type: 'input_text', text: part.text });
            } else if (part.inlineData) {
                const { mimeType = 'image/png', data } = part.inlineData;
                content.push({
                    type: 'input_image',
                    image_url: `data:${mimeType};base64,${data}`
                });
            } else if (part.image_url) {
                content.push({
                    type: 'input_image',
                    image_url: part.image_url
                });
            } else if (part.type === 'input_image') {
                content.push(part);
            }
        }
    }

    return content;
}

/**
 * One-shot generation call using OpenAI Responses API with the lightweight model.
 * Centralizes model selection, text extraction, and error/refusal handling.
 * Returns both the extracted text and the raw response so callers can inspect
 * output items (e.g. web_search_call) without a second request.
 */
export async function generateLiteContentWithResponse(prompt, options = {}) {
    if (!openaiClient) throw new Error('OpenAI client not initialized');

    const model = options.modelId || configuredLiteModelId;
    const requestPayload = {
        model,
    };

    // System instruction
    if (options.systemInstruction) {
        requestPayload.instructions = options.systemInstruction;
    }

    // Format content array
    const contentParts = formatOpenAiContent(prompt, options.multimodalParts);
    if (contentParts.length === 1 && contentParts[0].type === 'input_text') {
        requestPayload.input = contentParts[0].text;
    } else {
        requestPayload.input = [{ role: 'user', content: contentParts }];
    }

    // Structured JSON Output
    if (options.responseSchema) {
        const strictSchema = toOpenAiStrictSchema(options.responseSchema);
        requestPayload.text = {
            format: {
                type: 'json_schema',
                name: options.schemaName || 'structured_output',
                strict: true,
                schema: strictSchema
            }
        };
    }

    // Tools handling (map googleSearch to web_search)
    if (options.tools) {
        const toolsList = Array.isArray(options.tools) ? options.tools : [options.tools];
        requestPayload.tools = toolsList.map(t => {
            if (t.googleSearch || t.type === 'web_search') {
                return { type: 'web_search' };
            }
            return t;
        });
    }

    // Reasoning effort override if specified.
    // Note: options.temperature is intentionally NOT forwarded — reasoning models
    // (gpt-5.x) reject the temperature parameter; sampling is controlled via effort.
    if (options.reasoningEffort || configuredLiteReasoningEffort) {
        requestPayload.reasoning = {
            effort: options.reasoningEffort || configuredLiteReasoningEffort
        };
    }

    if (options.maxOutputTokens) {
        requestPayload.max_output_tokens = options.maxOutputTokens;
    }

    try {
        const response = await executeWithFlexFallback(
            (payload, reqOpts) => openaiClient.responses.create(payload, reqOpts),
            requestPayload,
            options,
            'openai.generateLiteContent'
        );

        // Check for content filter / refusal
        const refusal = extractRefusal(response);
        if (refusal) {
            logger.warn({ refusal }, 'OpenAI content generation refused.');
            return { text: null, response };
        }

        const extracted = response.output_text?.trim() || null;
        return { text: extracted, response };
    } catch (error) {
        logger.error({ err: error }, 'generateLiteContent failed');
        return { text: null, response: null };
    }
}

export async function generateLiteContent(prompt, options = {}) {
    const { text } = await generateLiteContentWithResponse(prompt, options);
    return text;
}
