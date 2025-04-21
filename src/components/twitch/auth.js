import axios from 'axios';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';

// Module-level cache for the token and its expiry time
let cachedToken = null;
let tokenExpiryTime = null; // Store expiry timestamp (in milliseconds)

const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before actual expiry

/**
 * Fetches a new App Access Token from Twitch using Client Credentials flow.
 * @returns {Promise<string>} Resolves with the new access token.
 * @throws {Error} If fetching the token fails after retries.
 */
async function fetchNewAppAccessToken() {
    logger.info('Attempting to fetch new Twitch App Access Token...');

    const { clientId, clientSecret } = config.twitch;
    if (!clientId || !clientSecret) {
        throw new Error('Missing TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET in configuration.');
    }

    try {
        const response = await axios.post(TWITCH_TOKEN_URL, null, { // Use null for data when sending form-urlencoded params
            params: {
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'client_credentials',
            },
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded' // Although params are used, specifying content-type is good practice
            },
            timeout: 10000, // 10 second timeout for the request
        });

        if (response.status === 200 && response.data && response.data.access_token) {
            const { access_token, expires_in } = response.data;
            // Calculate expiry time (subtracting buffer)
            tokenExpiryTime = Date.now() + (expires_in * 1000) - TOKEN_EXPIRY_BUFFER_MS;
            cachedToken = access_token;
            logger.info(`Successfully fetched and cached new Twitch App Access Token. Expires around: ${new Date(tokenExpiryTime).toISOString()}`);
            return cachedToken;
        } else {
            // Should not happen if status is 200, but belt-and-suspenders
            throw new Error(`Failed to fetch token, unexpected response structure. Status: ${response.status}`);
        }

    } catch (error) {
        let errorMessage = 'Failed to fetch Twitch App Access Token.';
        if (error.response) {
            // Request made and server responded with a status code out of 2xx range
            errorMessage = `${errorMessage} Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`;
            logger.error({
                status: error.response.status,
                data: error.response.data,
                headers: error.response.headers,
            }, errorMessage);
            // Specific check for common credential errors
            if (error.response.status === 400 || error.response.status === 401 || error.response.status === 403) {
                errorMessage += ' Please check TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET.';
            }
        } else if (error.request) {
            // The request was made but no response was received
            errorMessage = `${errorMessage} No response received from Twitch token endpoint. Check network connectivity.`;
            logger.error({ request: error.request }, errorMessage);
        } else {
            // Something happened in setting up the request that triggered an Error
            errorMessage = `${errorMessage} Error: ${error.message}`;
            logger.error({ err: error }, errorMessage);
        }
        // Throw a specific error after logging details
        throw new Error(errorMessage);
    }
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
        // fetchNew will update cachedToken and tokenExpiryTime on success
        return await fetchNewAppAccessToken();
    }
}

// Export the primary function needed by other modules
export { getAppAccessToken };

// Optionally, you could add an explicit initialization function if you wanted
// to fetch the first token during startup in bot.js, but the lazy-loading
// approach in getAppAccessToken() is often sufficient.
// async function initializeAuth() {
//     try {
//         await getAppAccessToken();
//         logger.info('Twitch Auth initialized successfully.');
//     } catch (error) {
//         logger.error({ err: error }, 'Failed to initialize Twitch Auth.');
//         throw error; // Propagate error for startup failure
//     }
// }
// export { getAppAccessToken, initializeAuth };