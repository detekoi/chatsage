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

/**
 * Extracts and normalizes service tier string ('flex', 'auto', or undefined) from options.
 */
export function resolveServiceTier(options = {}) {
    if (!options || typeof options !== 'object') return undefined;
    return options.serviceTier || options.service_tier || undefined;
}

/**
 * Retry helper for Flex processing requests.
 * Retries Flex request with exponential backoff on retryable errors.
 * If Flex capacity is exhausted or fails after retries, falls back to standard processing.
 *
 * @param {Function} flexFn - Async function executing the request on Flex tier
 * @param {Function} standardFn - Async fallback function executing on Standard tier
 * @param {string} operationName - Name of the operation for logging
 * @returns {Promise} Result of the successful call
 */
export async function retryWithFlexFallback(flexFn, standardFn, operationName = 'Flex LLM Call') {
    try {
        return await retryWithBackoff(flexFn, `${operationName} (Flex)`);
    } catch (error) {
        if (typeof standardFn === 'function') {
            const status = error?.status || error?.response?.status || error?.statusCode;
            logger.warn({
                operation: operationName,
                err: { message: error?.message, status }
            }, `${operationName}: Flex processing tier failed (${status || error?.message || 'error'}). Falling back to standard tier.`);
            return await retryWithBackoff(standardFn, `${operationName} (Standard Fallback)`);
        }
        throw error;
    }
}

/**
 * Helper to execute an LLM API call, automatically handling payload splitting and
 * fallback to Standard tier when serviceTier is 'flex'.
 *
 * @param {Function} apiCallFn - Async function (payload, requestOptions) => Promise
 * @param {Object} basePayload - Request payload or config object
 * @param {Object} [options={}] - Options object containing serviceTier/service_tier and optional timeout
 * @param {string} [operationName='LLM Call'] - Name of the operation for logging
 * @returns {Promise<any>}
 */
export async function executeWithFlexFallback(apiCallFn, basePayload, options = {}, operationName = 'LLM Call') {
    const serviceTier = resolveServiceTier(options);
    const reqOpts = options.timeout ? { timeout: options.timeout } : undefined;

    if (serviceTier === 'flex') {
        const flexPayload = { ...basePayload, service_tier: 'flex' };
        const stdPayload = { ...basePayload };
        delete stdPayload.service_tier;

        if (stdPayload.config && typeof stdPayload.config === 'object') {
            flexPayload.config = { ...stdPayload.config, serviceTier: 'flex' };
            stdPayload.config = { ...stdPayload.config };
            delete stdPayload.config.serviceTier;
        }

        return await retryWithFlexFallback(
            () => apiCallFn(flexPayload, reqOpts),
            () => apiCallFn(stdPayload, reqOpts),
            operationName
        );
    }

    const payload = serviceTier ? { ...basePayload, service_tier: serviceTier } : basePayload;
    return await retryWithBackoff(() => apiCallFn(payload, reqOpts), operationName);
}
