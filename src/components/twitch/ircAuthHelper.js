// src/components/twitch/ircAuthHelper.js
import axios from 'axios';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';
import { getSecretValue, setSecretValue } from '../../lib/secretManager.js'; // Import setSecretValue

const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

// Store the currently active access token in memory for the session
// eslint-disable-next-line no-unused-vars
let currentAccessToken = null;
let tokenFetchPromise = null; // Promise-based lock to prevent concurrent refreshes

/**
 * Refreshes the Twitch User Access Token using the securely stored Refresh Token.
 * @returns {Promise<string|null>} The new access token (without oauth: prefix), or null on failure.
 */
async function refreshIrcToken() {
    if (tokenFetchPromise) {
        logger.info('IRC token refresh already in progress. Waiting for ongoing refresh to complete.');
        return await tokenFetchPromise;
    }
    tokenFetchPromise = (async () => {
        logger.info('Attempting to refresh Twitch IRC Access Token...');

        // Wrap entire refresh operation with timeout to prevent indefinite hangs
        // Increased to 80s to allow for 3 retries with delays (3 × 10s timeout + 2s + 5s + 10s delays + overhead)
        const TOTAL_REFRESH_TIMEOUT_MS = 80000; // 80 seconds total timeout
        const refreshTimeoutPromise = new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Token refresh operation timed out after ${TOTAL_REFRESH_TIMEOUT_MS}ms`));
            }, TOTAL_REFRESH_TIMEOUT_MS);
        });

        const refreshOperation = (async () => {
            const { clientId, clientSecret } = config.twitch;
            const refreshTokenSecretName = config.secrets.twitchBotRefreshTokenName; // Get secret name from config

            if (!clientId || !clientSecret) {
                logger.error('Missing TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET for token refresh.');
                return null;
            }
            // In local dev, allow using a direct refresh token env var to avoid Secret Manager
            const localRefreshToken = process.env.TWITCH_BOT_REFRESH_TOKEN;
            if (!refreshTokenSecretName && !localRefreshToken) {
                logger.error('Missing TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME (or TWITCH_BOT_REFRESH_TOKEN) in configuration.');
                return null;
            }

            let refreshToken = null;
            if (localRefreshToken) {
                logger.warn('Using TWITCH_BOT_REFRESH_TOKEN from environment (local dev mode).');
                refreshToken = localRefreshToken;
            } else {
                // Secret Manager access with built-in retries (handled by getSecretValue)
                try {
                    const startTime = Date.now();
                    refreshToken = await getSecretValue(refreshTokenSecretName);
                    const elapsed = Date.now() - startTime;
                    logger.info(`Retrieved refresh token from Secret Manager in ${elapsed}ms`);

                    if (!refreshToken) {
                        throw new Error(`Secret Manager returned empty value for ${refreshTokenSecretName}`);
                    }
                } catch (error) {
                    logger.fatal({ err: error }, 'CRITICAL: Failed to retrieve refresh token from Secret Manager.');
                    return null;
                }
            }

            // Retry logic for network timeouts
            const MAX_RETRIES = 3;
            const RETRY_DELAYS = [2000, 5000, 10000]; // 2s, 5s, 10s - longer delays for network issues

            for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                try {
                    if (attempt > 0) {
                        const delay = RETRY_DELAYS[attempt - 1];
                        logger.info({ attempt: attempt + 1, delayMs: delay }, 'Retrying token refresh after delay...');
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }

                    // Create form data parameters for request body (consistent with curl -d approach)
                    const params = new URLSearchParams();
                    params.append('client_id', clientId);
                    params.append('client_secret', clientSecret);
                    params.append('grant_type', 'refresh_token');
                    params.append('refresh_token', refreshToken);

                    logger.debug({
                        attempt: attempt + 1,
                        url: TWITCH_TOKEN_URL,
                        hasClientId: !!clientId,
                        hasClientSecret: !!clientSecret,
                        hasRefreshToken: !!refreshToken
                    }, 'Sending token refresh request to Twitch...');

                    const response = await axios.post(TWITCH_TOKEN_URL, params, {
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded'
                        },
                        timeout: 10000,
                        // Add explicit network options for better Cloud Run compatibility
                        maxRedirects: 5,
                        validateStatus: (status) => status === 200,
                    });

                    if (response.status === 200 && response.data?.access_token) {
                        const newAccessToken = response.data.access_token;
                        const newRefreshToken = response.data.refresh_token; // Twitch *might* return a new refresh token

                        logger.info('Successfully refreshed Twitch IRC Access Token.');
                        currentAccessToken = newAccessToken; // Update in-memory cache

                        // If Twitch returns a new refresh token, update it in Secret Manager
                        if (newRefreshToken && newRefreshToken !== refreshToken) {
                            if (localRefreshToken) {
                                logger.warn('Received new refresh token, but running in local dev mode. Not updating Secret Manager. Please update TWITCH_BOT_REFRESH_TOKEN manually if desired.');
                            } else if (refreshTokenSecretName) {
                                logger.info('Received a new refresh token from Twitch. Storing it in Secret Manager.');
                                const success = await setSecretValue(refreshTokenSecretName, newRefreshToken);
                                if (success) {
                                    logger.info('Successfully updated refresh token in Secret Manager.');
                                } else {
                                    logger.error('Failed to update refresh token in Secret Manager. Will continue using the old token for future refreshes.');
                                }
                            }
                        }

                        return newAccessToken; // Return the new token
                    } else {
                        throw new Error(`Unexpected response structure during token refresh. Status: ${response.status}`);
                    }

                } catch (error) {
                    const isLastAttempt = attempt === MAX_RETRIES - 1;
                    const isTimeout = error.code === 'ECONNABORTED' || error.message?.includes('timeout');
                    const isNetworkError = error.request && !error.response; // No response received
                    const canRetry = (isTimeout || isNetworkError) && !isLastAttempt;

                    let errorMessage = 'Failed to refresh Twitch IRC Access Token.';

                    if (error.response) {
                        // Got a response from Twitch - don't retry on client errors
                        errorMessage = `${errorMessage} Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`;
                        logger.error({
                            status: error.response.status,
                            data: error.response.data,
                            attempt: attempt + 1
                        }, errorMessage);

                        // If refresh token is invalid, log critically and don't retry
                        if (error.response.status === 400 || error.response.status === 401) {
                            logger.fatal(`Refresh token is likely invalid or revoked (Status: ${error.response.status}). Manual intervention required to get a new refresh token.`);
                            currentAccessToken = null;
                        }
                        return null; // Don't retry on response errors

                    } else if (error.request) {
                        errorMessage = `${errorMessage} No response received from Twitch token endpoint.`;
                        logger.error({
                            attempt: attempt + 1,
                            maxRetries: MAX_RETRIES,
                            willRetry: canRetry,
                            isTimeout,
                            errorCode: error.code,
                            errorMessage: error.message,
                            syscall: error.syscall,
                            hostname: error.hostname
                        }, errorMessage);

                        if (canRetry) {
                            continue; // Retry on network errors
                        }
                        return null;

                    } else {
                        errorMessage = `${errorMessage} Error: ${error.message}`;
                        logger.error({ err: error, attempt: attempt + 1 }, errorMessage);
                        return null;
                    }
                }
            }

            // If we get here, all retries failed
            logger.error(`Token refresh failed after ${MAX_RETRIES} attempts`);
            return null;
        })();

        try {
            // Race the refresh operation against the total timeout
            return await Promise.race([refreshOperation, refreshTimeoutPromise]);
        } catch (error) {
            const isTimeout = error.message?.includes('timed out');
            logger.error({ err: error, isTimeout }, 'Token refresh failed or timed out');
            return null;
        }
    })();

    try {
        return await tokenFetchPromise;
    } finally {
        tokenFetchPromise = null; // Ensure lock is released
    }
}

/**
 * Gets a valid IRC access token, refreshing if necessary.
 * This should be called before attempting to connect to IRC.
 * @returns {Promise<string|null>} The valid access token (WITH oauth: prefix), or null if unable to obtain one.
 */
async function getValidIrcToken() {
    // For simplicity, we'll always try to refresh on startup or when requested.
    // A more optimized approach could store the access token securely too and check its expiry,
    // but refreshing is generally safe and ensures a fresh token.
    logger.info('Requesting valid IRC token, attempting refresh...');
    const newToken = await refreshIrcToken();

    if (newToken) {
        // tmi.js requires the 'oauth:' prefix
        return `oauth:${newToken}`;
    } else {
        logger.error('Failed to obtain a valid IRC token after refresh attempt.');
        return null;
    }
}

export { getValidIrcToken, refreshIrcToken }; // Export refreshIrcToken for potential manual trigger or error handling