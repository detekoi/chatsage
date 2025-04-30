import axios from 'axios';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';
import { getAppAccessToken, clearCachedAppAccessToken } from './auth.js'; // Import both functions

const TWITCH_HELIX_URL = 'https://api.twitch.tv/helix';

// Module-level variable to hold the configured Axios instance
let axiosInstance = null;

/**
 * Initializes the Axios instance for Helix API communication.
 * Configures base URL and interceptors for auth and logging.
 */
async function initializeHelixClient() {
    if (axiosInstance) {
        logger.warn('Helix client Axios instance already initialized.');
        return;
    }

    logger.info('Initializing Axios instance for Twitch Helix API...');

    axiosInstance = axios.create({
        baseURL: TWITCH_HELIX_URL,
        timeout: 8000, // 8 second timeout for API requests
    });

    // --- Axios Request Interceptor ---
    axiosInstance.interceptors.request.use(
        async (requestConfig) => {
            try {
                // Fetch the App Access Token before each request
                const token = await getAppAccessToken();
                requestConfig.headers['Authorization'] = `Bearer ${token}`;
                requestConfig.headers['Client-ID'] = config.twitch.clientId;
                logger.debug({ url: requestConfig.url, method: requestConfig.method }, 'Helix request prepared with auth headers.');
                // Add request start time for latency calculation
                requestConfig.meta = requestConfig.meta || {};
                requestConfig.meta.requestStartedAt = Date.now();
                return requestConfig;
            } catch (error) {
                logger.error({ err: error }, 'Failed to get App Access Token for Helix request.');
                // Prevent the request from proceeding without auth
                return Promise.reject(new Error('Failed to prepare Helix request authentication.'));
            }
        },
        (error) => {
            // Errors setting up the request
            logger.error({ err: error }, 'Error in Axios request interceptor setup');
            return Promise.reject(error);
        }
    );

    // --- Axios Response Interceptor ---
    axiosInstance.interceptors.response.use(
        (response) => {
            // Calculate latency
            const latencyMs = response.config.meta?.requestStartedAt ? Date.now() - response.config.meta.requestStartedAt : -1;

            // Log successful responses
            const rateLimitRemaining = response.headers['ratelimit-remaining'];
            logger.info({
                url: response.config.url,
                method: response.config.method,
                status: response.status,
                rateLimitRemaining: rateLimitRemaining ? parseInt(rateLimitRemaining, 10) : 'N/A',
                latencyMs: latencyMs,
            }, `Helix API call successful.`);
            return response;
        },
        (error) => {
            // Calculate latency even for errors if possible
             const latencyMs = error.config?.meta?.requestStartedAt ? Date.now() - error.config.meta.requestStartedAt : -1;

            // Log failed responses
            const commonLogData = {
                 url: error.config?.url,
                 method: error.config?.method,
                 latencyMs: latencyMs,
                 err: { // Avoid logging the full huge error object directly
                     message: error.message,
                     code: error.code,
                 }
            };

            if (error.response) {
                // The request was made and the server responded with a status code
                // that falls out of the range of 2xx
                const rateLimitRemaining = error.response.headers['ratelimit-remaining'];
                logger.error({
                    ...commonLogData,
                    status: error.response.status,
                    responseBody: error.response.data, // Log response body for debugging
                    rateLimitRemaining: rateLimitRemaining ? parseInt(rateLimitRemaining, 10) : 'N/A',
                }, `Helix API call failed with status ${error.response.status}`);

                // Specific handling/logging based on status code can be added here
                 if (error.response.status === 401) {
                    // Unauthorized - token might be invalid. Clear the cached token and log this occurrence.
                    logger.warn('Received 401 Unauthorized from Helix. Clearing cached App Access Token.');
                    clearCachedAppAccessToken();
                 } else if (error.response.status === 429) {
                    // Rate limit exceeded
                    const resetTime = error.response.headers['ratelimit-reset'];
                    const resetDate = resetTime ? new Date(parseInt(resetTime, 10) * 1000) : 'N/A';
                    logger.warn({ resetTimestamp: resetTime, resetDate }, 'Helix API rate limit exceeded (429).');
                    // NOTE: Actual retry/backoff logic should be implemented in the calling function (e.g., the poller)
                 } else if (error.response.status >= 500) {
                    // Server-side error
                    logger.error('Helix API encountered a server-side error (5xx).');
                 }

            } else if (error.request) {
                // The request was made but no response was received
                logger.error({ ...commonLogData, requestDetails: error.request }, 'Helix API call failed: No response received.');
            } else {
                // Something happened in setting up the request that triggered an Error
                logger.error({ ...commonLogData }, 'Helix API call failed: Error setting up request.');
            }

            // IMPORTANT: Re-reject the error so calling functions know it failed
            return Promise.reject(error);
        }
    );

    logger.info('Axios instance for Twitch Helix API initialized successfully.');
}

/**
 * Gets the initialized Axios instance for Helix API calls.
 * @returns {import('axios').AxiosInstance} The configured Axios instance.
 * @throws {Error} If the instance has not been initialized.
 */
function getHelixClient() {
    if (!axiosInstance) {
        throw new Error('Helix client Axios instance has not been initialized. Call initializeHelixClient first.');
    }
    return axiosInstance;
}

/**
 * Fetches channel information (game, title, tags) from Twitch Helix API.
 * @param {string[]} broadcasterIds - An array of broadcaster user IDs to query. Max 100 per request.
 * @returns {Promise<object[]>} A promise resolving to an array of channel information objects.
 *                                Returns an empty array if input is empty or on API error after logging.
 */
async function getChannelInformation(broadcasterIds) {
    if (!broadcasterIds || broadcasterIds.length === 0) {
        logger.warn('getChannelInformation called with empty broadcaster IDs.');
        return [];
    }
    if (broadcasterIds.length > 100) {
        logger.warn(`getChannelInformation called with ${broadcasterIds.length} IDs. Max 100 allowed per request. Truncating.`);
        broadcasterIds = broadcasterIds.slice(0, 100);
    }

    const client = getHelixClient(); // Ensures client is initialized
    const params = new URLSearchParams();
    broadcasterIds.forEach(id => params.append('broadcaster_id', id));

    logger.debug({ broadcasterIds }, 'Fetching channel information from Helix...');

    try {
        const response = await client.get('/channels', { params });
        // Spec: https://dev.twitch.tv/docs/api/reference/#get-channel-information
        // Data is expected in response.data.data
        return response.data?.data || [];
    } catch (error) {
        // Errors are already logged by the response interceptor
        logger.error({ err: { message: error.message, code: error.code } , broadcasterIds }, `Failed to get channel information for IDs: ${broadcasterIds.join(',')}`);
        // Return empty array for graceful degradation
        return [];
    }
}

/**
 * Fetches user information (including ID) from Twitch Helix API based on login names.
 * @param {string[]} loginNames - An array of user login names (channel names) to query. Max 100 per request.
 * @returns {Promise<object[]>} A promise resolving to an array of user objects from the API.
 *                                Returns an empty array if input is empty or on API error after logging.
 */
async function getUsersByLogin(loginNames) {
    if (!loginNames || loginNames.length === 0) {
        logger.warn('getUsersByLogin called with empty login names.');
        return [];
    }
    if (loginNames.length > 100) {
        logger.warn(`getUsersByLogin called with ${loginNames.length} names. Max 100 allowed per request. Truncating.`);
        loginNames = loginNames.slice(0, 100);
    }

    const client = getHelixClient(); // Ensures client is initialized
    const params = new URLSearchParams();
    loginNames.forEach(name => params.append('login', name));

    logger.debug({ loginNames }, 'Fetching user information by login from Helix...');

    try {
        const response = await client.get('/users', { params });
        // Spec: https://dev.twitch.tv/docs/api/reference/#get-users
        // Data is expected in response.data.data
        return response.data?.data || [];
    } catch (error) {
         // Errors are already logged by the response interceptor
         logger.error({ err: { message: error.message, code: error.code } , loginNames }, `Failed to get user information for logins: ${loginNames.join(',')}`);
         // Return empty array for graceful degradation
         return [];
    }
}


// Export initializer, getter, and specific API call functions
export {
    initializeHelixClient,
    getHelixClient,
    getChannelInformation,
    getUsersByLogin, // <-- Added export
};