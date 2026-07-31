import logger from '../../lib/logger.js';

export const MAX_RETRIES = 3;
export const BASE_RETRY_DELAY_MS = 500;

/**
 * Check if an error is retryable (network failures, timeouts, 500, 502, 503, 504, 429, OpenAI APIConnectionError)
 */
export function isRetryableError(error) {
    const status = error?.status || error?.response?.status || error?.statusCode;
    if (status === 503 || status === 429 || status === 500 || status === 502 || status === 504) return true;

    const name = error?.name || '';
    if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError' || name === 'InternalServerError') {
        return true;
    }

    const message = error?.message || '';
    // Check for network-level failures
    if (/fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|Connection error/i.test(message)) return true;
    // Check for timeout errors
    if (/\b(500|502|503|504)\b|Service Unavailable|Bad Gateway|Gateway Timeout|timeout|timed out/i.test(message)) return true;

    return false;
}

/**
 * Sleep helper for retry backoff
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry wrapper with exponential backoff for LLM API calls
 * @param {Function} fn - Async function to retry
 * @param {string} operationName - Name of the operation for logging
 * @returns {Promise} Result of the function call
 */
export async function retryWithBackoff(fn, operationName = 'LLM API call') {
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
