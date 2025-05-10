// src/components/twitch/auth.js
import axios from 'axios';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';
import { sleep } from '../../lib/timeUtils.js'; // Assuming you have a sleep utility

// Module-level cache for the token and its expiry time
let cachedToken = null;
let tokenExpiryTime = null; // Store expiry timestamp (in milliseconds)

const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before actual expiry

const MAX_FETCH_RETRIES = 3; // Max number of retries for fetching the token
const RETRY_DELAY_MS = 5000; // Delay between retries in milliseconds (5 seconds)

/**
 * Fetches a new App Access Token from Twitch using Client Credentials flow with retry logic.
 * @returns {Promise<string>} Resolves with the new access token.
 * @throws {Error} If fetching the token fails after all retries.
 */
async function fetchNewAppAccessToken() {
    logger.info('Attempting to fetch new Twitch App Access Token...');

    const { clientId, clientSecret } = config.twitch;
    if (!clientId || !clientSecret) {
        // This is a configuration error, retrying won't help.
        throw new Error('Missing TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET in configuration.');
    }

    let lastError = null;

    for (let attempt = 1; attempt <= MAX_FETCH_RETRIES; attempt++) {
        try {
            logger.info(`Workspaceing App Access Token - Attempt ${attempt}/${MAX_FETCH_RETRIES}...`);
            const response = await axios.post(TWITCH_TOKEN_URL, null, {
                params: {
                    client_id: clientId,
                    client_secret: clientSecret,
                    grant_type: 'client_credentials',
                },
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                timeout: config.app.externalApiTimeout || 15000, // Use configured timeout or default to 15s
            });

            if (response.status === 200 && response.data && response.data.access_token) {
                const { access_token, expires_in } = response.data;
                tokenExpiryTime = Date.now() + (expires_in * 1000) - TOKEN_EXPIRY_BUFFER_MS;
                cachedToken = access_token;
                logger.info(`Successfully fetched and cached new Twitch App Access Token (Attempt ${attempt}). Expires around: ${new Date(tokenExpiryTime).toISOString()}`);
                return cachedToken;
            } else {
                // Should not happen if status is 200, but treat as an error for retry
                lastError = new Error(`Failed to fetch token, unexpected response structure. Status: ${response.status}`);
                logger.warn(`Attempt ${attempt} failed: ${lastError.message}`);
            }
        } catch (error) {
            lastError = error; // Store the error for this attempt
            let isRetryable = false;

            // Log detailed error for debugging
            const errorDetails = {
                err: {
                    message: error.message,
                    code: error.code,
                    name: error.name,
                    status: error.response?.status,
                    responseData: error.response?.data,
                },
                request: { url: TWITCH_TOKEN_URL, method: 'POST' },
                attempt: `${attempt}/${MAX_FETCH_RETRIES}`,
                timestamp: new Date().toISOString(),
            };
            // Avoid logging full stack for timeouts or common network errors on retries unless it's the last attempt
            if (attempt === MAX_FETCH_RETRIES || !(error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || error.response?.status >= 500)) {
                errorDetails.err.stack = error.stack;
            }
            logger.error(errorDetails, `Error during fetchNewAppAccessToken attempt ${attempt}`);


            // Decide if the error is retryable
            if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') { // Timeout errors
                isRetryable = true;
                logger.warn(`Attempt ${attempt} failed due to timeout. Retrying if possible...`);
            } else if (error.response) {
                // Server responded with an error status
                if (error.response.status >= 500) { // Server-side errors (5xx) are often transient
                    isRetryable = true;
                    logger.warn(`Attempt ${attempt} failed with status ${error.response.status} (server error). Retrying if possible...`);
                } else if (error.response.status === 429) { // Too Many Requests
                    isRetryable = true;
                    logger.warn(`Attempt ${attempt} failed with status 429 (Too Many Requests). Retrying after delay...`);
                } else {
                    // Client-side errors (4xx, excluding 429) are usually not retryable (e.g., invalid credentials)
                    // We will break the loop and throw after this attempt.
                    logger.error(`Attempt ${attempt} failed with status ${error.response.status}. This is likely not retryable. Error: ${JSON.stringify(error.response.data)}`);
                }
            } else if (error.request) {
                // Request made but no response (network error)
                isRetryable = true;
                logger.warn(`Attempt ${attempt} failed: No response received. Retrying if possible...`);
            } else {
                // Setup error or unknown error, usually not retryable
                logger.error(`Attempt ${attempt} failed with setup error: ${error.message}. This is likely not retryable.`);
            }

            if (isRetryable && attempt < MAX_FETCH_RETRIES) {
                logger.info(`Waiting ${RETRY_DELAY_MS / 1000} seconds before next retry...`);
                await sleep(RETRY_DELAY_MS); // Wait before retrying
                continue; // Go to the next iteration of the loop
            }

            // If not retryable, or if it's the last attempt, break and throw.
            break;
        }
    }

    // If the loop completes without returning, it means all retries failed.
    let finalErrorMessage = 'Failed to fetch Twitch App Access Token after all retries.';
    if (lastError) {
        finalErrorMessage = `Failed to fetch Twitch App Access Token after ${MAX_FETCH_RETRIES} attempts. Last error: ${lastError.message}`;
        if (lastError.response) {
            finalErrorMessage += ` Status: ${lastError.response.status}, Data: ${JSON.stringify(lastError.response.data)}`;
            if (lastError.response.status === 400 || lastError.response.status === 401 || lastError.response.status === 403) {
                finalErrorMessage += ' Please check TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET.';
            }
        }
    }
    // The detailed error was already logged inside the loop on the last attempt or for non-retryable errors.
    throw new Error(finalErrorMessage);
}

/**
 * Gets a valid Twitch App Access Token, fetching a new one if necessary.
 * @returns {Promise<string>} Resolves with a valid access token.
 * @throws {Error} If unable to retrieve a valid token.
 */
async function getAppAccessToken() {
    const now = Date.now();

    if (cachedToken && tokenExpiryTime && now < tokenExpiryTime) {
        logger.debug('Using cached Twitch App Access Token.');
        return cachedToken;
    } else {
        if (cachedToken) {
             logger.info('Cached Twitch App Access Token expired or nearing expiry. Fetching new token...');
        } else {
             logger.info('No cached Twitch App Access Token found. Fetching new token...');
        }
        // fetchNewAppAccessToken will update cachedToken and tokenExpiryTime on success
        return await fetchNewAppAccessToken();
    }
}

/**
 * Clears the cached App Access Token, forcing a refresh on the next request.
 * Intended to be called externally when a 401 error is detected.
 */
function clearCachedAppAccessToken() {
    logger.warn('Clearing cached Twitch App Access Token due to external trigger (e.g., 401 error).');
    cachedToken = null;
    tokenExpiryTime = null;
}

// Export the primary functions needed by other modules
export { getAppAccessToken, clearCachedAppAccessToken };