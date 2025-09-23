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
            // Add resilience: bounded retries around Secret Manager access with backoff and a per-attempt timeout
            const maxAttempts = 3;
            const baseDelayMs = 1000;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    refreshToken = await getSecretValue(refreshTokenSecretName);
                    if (!refreshToken) {
                        throw new Error(`Secret Manager returned empty value for ${refreshTokenSecretName}`);
                    }
                    break; // success
                } catch (error) {
                    const isLast = attempt === maxAttempts;
                    logger.error({ err: { message: error?.message } }, `Failed to retrieve refresh token from Secret Manager (attempt ${attempt}/${maxAttempts}).`);
                    if (isLast) {
                        logger.fatal({ err: error }, 'CRITICAL: Failed to retrieve refresh token from secure storage after retries.');
                        return null;
                    }
                    const delay = baseDelayMs * Math.pow(2, attempt - 1);
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        }

        try {
            // Create form data parameters for request body (consistent with curl -d approach)  
            const params = new URLSearchParams();
            params.append('client_id', clientId);
            params.append('client_secret', clientSecret);
            params.append('grant_type', 'refresh_token');
            params.append('refresh_token', refreshToken);
            
            const response = await axios.post(TWITCH_TOKEN_URL, params, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                timeout: 10000,
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
            let errorMessage = 'Failed to refresh Twitch IRC Access Token.';
            if (error.response) {
                errorMessage = `${errorMessage} Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`;
                logger.error({
                    status: error.response.status,
                    data: error.response.data,
                }, errorMessage);
                // If refresh token is invalid, log critically
                if (error.response.status === 400 || error.response.status === 401) {
                    logger.fatal(`Refresh token is likely invalid or revoked (Status: ${error.response.status}). Manual intervention required to get a new refresh token.`);
                    // TODO: Trigger an alert or notification here.
                    // Invalidate the currentAccessToken to prevent further attempts with it
                    currentAccessToken = null;
                }
            } else if (error.request) {
                errorMessage = `${errorMessage} No response received from Twitch token endpoint.`;
                logger.error({ request: error.request }, errorMessage);
            } else {
                errorMessage = `${errorMessage} Error: ${error.message}`;
                logger.error({ err: error }, errorMessage);
            }
            return null; // Indicate refresh failure
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