import logger from '../../../lib/logger.js';

export { MAX_RETRIES, BASE_RETRY_DELAY_MS, isRetryableError, sleep, retryWithBackoff, retryWithFlexFallback, resolveServiceTier, executeWithFlexFallback } from '../retryUtils.js';

// Helper to extract text from Gemini responses in a robust way
export function extractTextFromResponse(response, candidate, logContext = 'response') {
    // Prefer SDK-provided text fields where available
    // Some SDK variants expose candidate.text directly
    if (candidate && typeof candidate.text === 'string' && candidate.text.trim().length > 0) {
        return candidate.text.trim();
    }
    // Fallback: SDK convenience method
    if (response && typeof response.text === 'function') {
        const text = response.text();
        return typeof text === 'string' ? text.trim() : null;
    }
    // Parts array present: prefer the first non-empty text part to avoid accidental duplication when
    // SDK splits content into multiple similar parts.
    const parts = candidate?.content?.parts;
    if (Array.isArray(parts) && parts.length > 0) {
        for (const part of parts) {
            const t = typeof part?.text === 'string' ? part.text.trim() : '';
            if (t.length > 0) return t;
        }
        // Last-resort: deduplicate and join any text-bearing parts into a single string
        const texts = parts.map(p => (typeof p?.text === 'string' ? p.text.trim() : '')).filter(Boolean);
        if (texts.length > 0) {
            const combined = texts.join(' ');
            const sentences = combined.split(/(?<=[.!?])\s+/).filter(Boolean);
            const seen = new Set();
            const uniqueSentences = [];
            for (const s of sentences) {
                const st = s.trim();
                if (!seen.has(st)) { seen.add(st); uniqueSentences.push(st); }
            }
            const deduped = (uniqueSentences.length > 0 ? uniqueSentences.join(' ') : combined).trim();
            if (deduped.length > 0) return deduped;
        }
        return '';
    }
    // Newer SDKs may expose response.text as a string property
    if (response && typeof response.text === 'string' && response.text.trim().length > 0) {
        return response.text.trim();
    }
    // As a last resort, nothing extractable
    // Nothing we can extract
    logger.warn({ logContext }, 'Could not extract text from Gemini response.');
    return null;
}

/**
 * Standardized helper to extract text from a Gemini generateContent response candidate.
 * Wraps extractTextFromResponse.
 * @param {object} result - The raw Gemini API result object
 * @param {string} logContext - Logging context
 * @returns {string|null} Extracted text or null
 */
export function safeExtractText(result, logContext = 'gemini') {
    if (!result) return null;
    const candidate = result.candidates?.[0];
    return extractTextFromResponse(result, candidate, logContext);
}

/**
 * Standardized helper to parse JSON from a Gemini generateContent response.
 * @param {object} result - The raw Gemini API result object
 * @param {string} logContext - Logging context
 * @returns {object|null} Parsed JSON object or null on failure
 */
export function safeParseJsonResponse(result, logContext = 'gemini') {
    const text = safeExtractText(result, logContext);
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch (error) {
        logger.warn({ err: error, logContext, text }, 'Failed to parse JSON response');
        return null;
    }
}

