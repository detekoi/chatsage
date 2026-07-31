import logger from '../../../lib/logger.js';

/**
 * Standardized helper to extract text from an OpenAI Responses API response.
 * @param {object} response - The raw OpenAI response object
 * @param {string} logContext - Logging context
 * @returns {string|null} Extracted text or null
 */
/**
 * Finds a refusal in a Responses API response. Refusals appear as content items
 * of type 'refusal' inside 'message' output items (output[0] is usually 'reasoning').
 * @returns {string|null} The refusal text, or null if none
 */
export function extractRefusal(response) {
    if (!Array.isArray(response?.output)) return null;
    for (const item of response.output) {
        if (item.type === 'message' && Array.isArray(item.content)) {
            for (const part of item.content) {
                if (part.type === 'refusal') {
                    return part.refusal || 'Refused without message.';
                }
            }
        }
    }
    return null;
}

export function safeExtractText(response, logContext = 'openai') {
    if (!response) return null;

    const refusal = extractRefusal(response);
    if (refusal) {
        logger.warn({ logContext, refusal }, 'OpenAI response contained refusal.');
        return null;
    }

    // Direct output_text property on Responses API
    if (typeof response.output_text === 'string' && response.output_text.trim().length > 0) {
        return response.output_text.trim();
    }

    // Fallback: walk output array
    if (Array.isArray(response.output)) {
        const textParts = [];
        for (const item of response.output) {
            if (item.type === 'message' && Array.isArray(item.content)) {
                for (const part of item.content) {
                    if (part.type === 'text' && typeof part.text === 'string') {
                        textParts.push(part.text);
                    }
                }
            } else if (item.text && typeof item.text === 'string') {
                textParts.push(item.text);
            }
        }

        if (textParts.length > 0) {
            return textParts.join(' ').trim();
        }
    }

    logger.warn({ logContext }, 'Could not extract text from OpenAI response.');
    return null;
}

/**
 * Standardized helper to parse JSON from an OpenAI Responses API response.
 * @param {object} response - The raw OpenAI response object
 * @param {string} logContext - Logging context
 * @returns {object|null} Parsed JSON object or null on failure
 */
export function safeParseJsonResponse(response, logContext = 'openai') {
    if (!response) return null;

    // Prefer SDK parsed output if present
    if (response.output_parsed && typeof response.output_parsed === 'object') {
        return response.output_parsed;
    }

    const text = safeExtractText(response, logContext);
    if (!text) return null;

    try {
        return JSON.parse(text);
    } catch (error) {
        logger.warn({ err: error, logContext, text }, 'Failed to parse JSON response from OpenAI');
        return null;
    }
}
