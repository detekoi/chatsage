// src/components/llm/geminiImageClient.js
import logger from '../../lib/logger.js';
import { describeImages } from './geminiClient.js';
import config from '../../config/loader.js';
import axios from 'axios';

/**
 * Analyzes an image using the active LLM provider's image understanding capabilities
 * @param {Buffer|string} imageData - The image data as a Buffer or base64 string
 * @param {string} prompt - The prompt to send along with the image
 * @param {string} mimeType - The MIME type of the image (default: 'image/jpeg')
 * @returns {Promise<string|null>} The generated text response or null if failed
 */
export async function analyzeImage(imageData, prompt, mimeType = 'image/jpeg') {
    try {
        const base64Data = Buffer.isBuffer(imageData)
            ? imageData.toString('base64')
            : imageData;

        const parts = [{ inlineData: { mimeType, data: base64Data } }];
        const modelId = config.llm?.provider === 'openai' ? config.openai.modelId : config.gemini.modelId;

        logger.info({ promptLength: prompt.length }, 'Generating image analysis response');
        const text = await describeImages({ parts, prompt, modelId, temperature: 0.2, thinkingLevel: 'high' });

        if (text && text.trim().length > 0) {
            return text.trim();
        }

        // Targeted single retry for sparse/truncated responses, with a raised
        // token ceiling so the retry doesn't hit the same MAX_TOKENS failure.
        const shortPrompt = 'Briefly describe the scene in ≤ 140 characters. Plain text only.';
        const retryText = await describeImages({ parts, prompt: shortPrompt, modelId, temperature: 0.2, thinkingLevel: 'high', maxOutputTokens: 4096 });
        return retryText?.trim() || null;
    } catch (error) {
        logger.error({ err: error }, 'Error during image analysis');
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

        return result;
    } catch (error) {
        logger.error({ err: error }, 'Error during object detection with LLM');
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

        const jsonMatch = result.match(/{[\s\S]*}/);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[0]);
            } catch (parseError) {
                logger.error({ err: parseError }, 'Error parsing game analysis JSON response');
                return {
                    game: "Unknown",
                    activity: result,
                    ui_elements: []
                };
            }
        }

        return {
            game: "Unknown",
            activity: result,
            ui_elements: []
        };
    } catch (error) {
        logger.error({ err: error }, 'Error during game stream analysis');
        return null;
    }
}