// src/components/llm/geminiImageClient.js
import logger from '../../lib/logger.js';
import { getGeminiClient } from './geminiClient.js';
import axios from 'axios';

/**
 * Analyzes an image using Gemini 2.0 Flash and returns the response
 * @param {Buffer} imageData - The image data as a Buffer
 * @param {string} prompt - The prompt to send along with the image
 * @param {string} mimeType - The MIME type of the image (default: 'image/jpeg')
 * @returns {Promise<string|null>} The generated text response or null if failed
 */
export async function analyzeImage(imageData, prompt, mimeType = 'image/jpeg') {
    try {
        const model = getGeminiClient();
        if (!model) {
            throw new Error('Gemini client not initialized');
        }

        logger.info({ promptLength: prompt.length }, 'Generating image analysis response');

        // Convert buffer to base64 if needed
        const base64Data = Buffer.isBuffer(imageData) 
            ? imageData.toString('base64')
            : imageData;

        // Prepare the request with inline image data
        const result = await model.generateContent({
            contents: [{
                role: 'user',
                parts: [
                    { inlineData: { mimeType: mimeType, data: base64Data } },
                    { text: prompt }
                ]
            }],
            generationConfig: { maxOutputTokens: 300, responseMimeType: 'text/plain' }
        });

        // Extract and process the response
        const response = result.response;
        
        // Check for safety blocks
        if (response.promptFeedback?.blockReason) {
            logger.warn({
                blockReason: response.promptFeedback.blockReason,
                safetyRatings: response.promptFeedback.safetyRatings,
            }, 'Gemini image analysis request blocked due to safety settings');
            return null;
        }

        const candidate = response.candidates?.[0];
        if (!candidate) {
            logger.warn('Gemini image analysis response missing candidates or content');
            return null;
        }
        const parts = candidate.content?.parts;
        if (!Array.isArray(parts) || parts.length === 0) {
            // Try SDK convenience method
            if (typeof response.text === 'function') {
                const fallback = response.text();
                if (typeof fallback === 'string' && fallback.trim().length > 0) {
                    logger.info({ responseLength: fallback.length }, 'Successfully generated image analysis response');
                    return fallback.trim();
                }
            }
            logger.warn('Gemini image analysis response candidate missing content parts.');
            return null;
        }
        const text = parts.map(part => part.text || '').join('');
        
        logger.info({ responseLength: text.length }, 'Successfully generated image analysis response');
        return text.trim();
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