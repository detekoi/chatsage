// src/components/llm/geminiImageClient.js
import logger from '../../lib/logger.js';
import { getGeminiClient, getGenAIInstance } from './geminiClient.js';
import axios from 'axios';

/**
 * Analyzes an image using Gemini's image understanding capabilities
 * Follows Google's image understanding documentation: https://ai.google.dev/gemini-api/docs/image-understanding
 * @param {Buffer} imageData - The image data as a Buffer
 * @param {string} prompt - The prompt to send along with the image
 * @param {string} mimeType - The MIME type of the image (default: 'image/jpeg')
 * @returns {Promise<string|null>} The generated text response or null if failed
 */
export async function analyzeImage(imageData, prompt, mimeType = 'image/jpeg') {
    try {
        // Prefer a lighter image-capable, persona-less model for analysis to avoid heavy reasoning tokens
        let model = null;
        try {
            const genAI = getGenAIInstance();
            const modelId = process.env.GEMINI_MODEL_ID || 'gemini-2.5-flash';
            // Store the AI instance and model config for later use
            model = {
                ai: genAI,
                modelId: modelId,
                config: {
                    responseMimeType: 'text/plain',
                    maxOutputTokens: 8192,
                    temperature: 0.2,
                    thinkingConfig: { thinkingLevel: 'high' }
                }
            };
            logger.debug(`Using image model: ${modelId}`);
        } catch (_) {
            model = getGeminiClient();
            if (!model) {
                throw new Error('Gemini client not initialized');
            }
            logger.debug('Using default generative model for image analysis');
        }

        logger.info({ promptLength: prompt.length }, 'Generating image analysis response');

        // Convert buffer to base64 if needed
        const base64Data = Buffer.isBuffer(imageData)
            ? imageData.toString('base64')
            : imageData;

        // Minimal request per working commit: image then prompt, no extra config
        // Use the appropriate model based on what was initialized
        let result;
        if (model.ai && model.modelId) {
            // Use message with role and parts per Gemini image understanding docs
            result = await model.ai.models.generateContent({
                model: model.modelId,
                contents: [{
                    role: 'user',
                    parts: [
                        { inlineData: { mimeType: mimeType, data: base64Data } },
                        { text: prompt }
                    ]
                }],
                config: model.config
            });
        } else {
            // Fallback to wrapper model
            result = await model.generateContent({
                contents: [{
                    role: 'user',
                    parts: [
                        { inlineData: { mimeType: mimeType, data: base64Data } },
                        { text: prompt }
                    ]
                }]
            });
        }

        const response = result;
        const candidate = response?.candidates?.[0];
        const parts = candidate?.content?.parts;
        if (Array.isArray(parts) && parts.length > 0) {
            const text = parts.map(part => part?.text || '').join('');
            return text.trim();
        }
        // Fallbacks: response.text() or candidate.text
        if (typeof response?.text === 'function') {
            const t = response.text();
            if (typeof t === 'string' && t.trim().length > 0) return t.trim();
        }
        if (typeof candidate?.text === 'string' && candidate.text.trim().length > 0) {
            return candidate.text.trim();
        }
        logger.warn({ finishReason: candidate?.finishReason, promptFeedback: response?.promptFeedback, usageMetadata: response?.usageMetadata }, 'Gemini image analysis response candidate missing content parts.');

        // Targeted single retry for sparse/MAX_TOKENS responses with a concise instruction
        try {
            const shortPrompt = 'Briefly describe the in-game scene in ≤ 140 characters. Plain text only.';
            let retry;
            if (model.ai && model.modelId) {
                // Use message with role and parts; slightly higher token cap for retry
                retry = await model.ai.models.generateContent({
                    model: model.modelId,
                    contents: [{
                        role: 'user',
                        parts: [
                            { inlineData: { mimeType: mimeType, data: base64Data } },
                            { text: shortPrompt }
                        ]
                    }],
                    config: { ...model.config, maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: 'high' } }
                });
            } else {
                // Fallback to wrapper model
                retry = await model.generateContent({
                    contents: [{
                        role: 'user',
                        parts: [
                            // Per docs, place the image before the text prompt when using a single image
                            { inlineData: { mimeType: mimeType, data: base64Data } },
                            { text: shortPrompt }
                        ]
                    }]
                });
            }
            const retryResponse = retry;
            const retryCandidate = retryResponse?.candidates?.[0];
            const retryParts = retryCandidate?.content?.parts;
            if (Array.isArray(retryParts) && retryParts.length > 0) {
                const retryText = retryParts.map(p => p?.text || '').join('');
                if (retryText.trim().length > 0) return retryText.trim();
            }
            if (typeof retryResponse?.text === 'function') {
                const rt = retryResponse.text();
                if (typeof rt === 'string' && rt.trim().length > 0) return rt.trim();
            }
            if (typeof retryCandidate?.text === 'string' && retryCandidate.text.trim().length > 0) {
                return retryCandidate.text.trim();
            }
            logger.warn({ finishReason: retryCandidate?.finishReason, promptFeedback: retryResponse?.promptFeedback, usageMetadata: retryResponse?.usageMetadata }, 'Retry image analysis still missing content parts.');
        } catch (retryErr) {
            logger.error({ err: retryErr }, 'Error during retry image analysis call');
        }
        return null;
    } catch (error) {
        logger.error({ err: error }, 'Error during image analysis with Gemini');
        return null;
    }
}

/**
 * Fetches an image from a URL and returns it as a base64 string
 * @param {string} imageUrl - The URL of the image to fetch
 * @returns {Promise<string|null>} The base64-encoded image data or null if failed
 */
export async function fetchImageAsBase64(imageUrl) {
    try {
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const base64 = Buffer.from(response.data, 'binary').toString('base64');
        return base64;
    } catch (error) {
        logger.error({ err: error, url: imageUrl }, 'Error fetching image from URL');
        return null;
    }
}

/**
 * Detects objects in an image and returns their bounding boxes
 * @param {Buffer|string} imageData - The image data as a Buffer or base64 string
 * @param {string} [objectTypes] - Optional specific object types to detect
 * @returns {Promise<Array|null>} Array of detected objects with bounding boxes or null if failed
 */
export async function detectObjects(imageData, objectTypes = '') {
    const prompt = `Detect ${objectTypes ? objectTypes : 'all prominent items'} in the image. 
                    For each object, provide a JSON object with "label" and "box_2d" properties. 
                    The box_2d should be [ymin, xmin, ymax, xmax] normalized to 0-1000.
                    Return the results as a valid JSON array of objects.`;

    try {
        const result = await analyzeImage(imageData, prompt);
        if (!result) return null;

        // Try to extract the JSON array from the response
        const jsonMatch = result.match(/\[\s*{[\s\S]*}\s*\]/);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[0]);
            } catch (parseError) {
                logger.error({ err: parseError }, 'Error parsing object detection JSON response');
                return null;
            }
        }

        // If no JSON array could be extracted, return the text response
        return result;
    } catch (error) {
        logger.error({ err: error }, 'Error during object detection with Gemini');
        return null;
    }
}

/**
 * Analyzes game stream content from a thumbnail or screenshot
 * @param {Buffer|string} imageData - The image data as a Buffer or base64 string
 * @returns {Promise<object|null>} Object with game information or null if failed
 */
export async function analyzeGameStream(imageData) {
    const prompt = `This is a screenshot from a video game stream. 
                   Analyze what game is being played, what's happening in the game,
                   and any notable UI elements visible.
                   Format response as a JSON object with "game", "activity", and "ui_elements" properties.`;

    try {
        const result = await analyzeImage(imageData, prompt);
        if (!result) return null;

        // Try to extract the JSON object from the response
        const jsonMatch = result.match(/{[\s\S]*}/);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[0]);
            } catch (parseError) {
                logger.error({ err: parseError }, 'Error parsing game analysis JSON response');
                // Return a structured object based on the text response
                return {
                    game: "Unknown",
                    activity: result,
                    ui_elements: []
                };
            }
        }

        // If no JSON object could be extracted, return a structured object with the text
        return {
            game: "Unknown",
            activity: result,
            ui_elements: []
        };
    } catch (error) {
        logger.error({ err: error }, 'Error during game stream analysis with Gemini');
        return null;
    }
}