import logger from '../../../lib/logger.js';

// --- Retry Logic for Network Failures ---
export const MAX_RETRIES = 3;
export const BASE_RETRY_DELAY_MS = 500;

/**
 * Check if an error is retryable (network failures, timeouts, 503s)
 */
export function isRetryableError(error) {
    const status = error?.status || error?.response?.status;
    if (status === 503 || status === 429 || status === 500) return true;

    const message = error?.message || '';
    // Check for network-level failures
    if (/fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(message)) return true;
    // Check for timeout errors
    if (/\b503\b|Service Unavailable|timeout|timed out/i.test(message)) return true;

    return false;
}

/**
 * Sleep helper for retry backoff
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry wrapper with exponential backoff for Gemini API calls
 * @param {Function} fn - Async function to retry
 * @param {string} operationName - Name of the operation for logging
 * @returns {Promise} Result of the function call
 */
export async function retryWithBackoff(fn, operationName = 'Gemini API call') {
    let lastError;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            const attemptNum = attempt + 1;

            if (isRetryableError(error) && attempt < MAX_RETRIES - 1) {
                const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 200);
                logger.warn({
                    attempt: attemptNum,
                    delay,
                    operation: operationName,
                    err: { message: error.message, status: error?.status }
                }, `${operationName} failed with retryable error. Retrying with backoff.`);
                await sleep(delay);
                continue;
            }

            // Non-retryable error or out of retries
            logger.error({
                attempt: attemptNum,
                operation: operationName,
                err: { message: error.message, status: error?.status, stack: error.stack }
            }, `${operationName} failed (not retryable or out of retries).`);
            throw error;
        }
    }

    throw lastError;
}

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
