import axios from 'axios';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';
import { getAppAccessToken, clearCachedAppAccessToken } from './auth.js'; // Import both functions

const TWITCH_HELIX_URL = 'https://api.twitch.tv/helix';

// Module-level variable to hold the configured Axios instance
let axiosInstance = null;

/**
 * Retry helper with exponential backoff
 * @param {Function} fn - Function to retry
 * @param {number} retries - Number of retry attempts
 * @param {number} delay - Initial delay in ms
 * @returns {Promise} Result of the function call
 */
async function retryWithBackoff(fn, retries = 3, delay = 1000) {
    try {
        return await fn();
    } catch (error) {
        if (retries === 0) {
            throw error;
        }
        
        // Check if this is a timeout or network error that should be retried
        const code = error.code || '';
        const status = error.response?.status;
        const message = error.message || '';
        const networkNoResponse = !!error.request && !error.response; // request made, no response
        const shouldRetry = code === 'ECONNABORTED' ||
                           code === 'ETIMEDOUT' ||
                           code === 'ESOCKETTIMEDOUT' ||
                           code === 'ENOTFOUND' ||
                           code === 'EAI_AGAIN' ||
                           message.toLowerCase().includes('timeout') ||
                           status === 408 ||
                           (status && status >= 500) ||
                           networkNoResponse;
        
        if (!shouldRetry) {
            throw error;
        }
        
        logger.warn({ error: error.message, retriesLeft: retries, delayMs: delay }, 'Retrying API call after error');
        await new Promise(resolve => setTimeout(resolve, delay));
        return retryWithBackoff(fn, retries - 1, delay * 2);
    }
}

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
        timeout: 30000, // Increase to 30s to better handle slow Helix responses
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
        const response = await retryWithBackoff(async () => {
            return await client.get('/channels', { params });
        }, 3, 1000);
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
        // Use retry logic for user lookups (critical for EventSub subscriptions)
        const response = await retryWithBackoff(async () => {
            return await client.get('/users', { params });
        }, 3, 1000);
        
        // Spec: https://dev.twitch.tv/docs/api/reference/#get-users
        // Data is expected in response.data.data
        return response.data?.data || [];
    } catch (error) {
         // Errors are already logged by the response interceptor
         logger.error({ err: { message: error.message, code: error.code } , loginNames }, `Failed to get user information for logins after retries: ${loginNames.join(',')}`);
         // Return empty array for graceful degradation
         return [];
    }
}

/**
 * Fetches live stream information from Twitch Helix API.
 * @param {string[]} broadcasterIds - An array of broadcaster user IDs to query. Max 100 per request.
 * @returns {Promise<object[]>} A promise resolving to an array of live stream objects.
 *                                Returns an empty array if input is empty or on API error after logging.
 */
async function getLiveStreams(broadcasterIds) {
    if (!broadcasterIds || broadcasterIds.length === 0) {
        logger.warn('getLiveStreams called with empty broadcaster IDs.');
        return [];
    }
    if (broadcasterIds.length > 100) {
        logger.warn(`getLiveStreams called with ${broadcasterIds.length} IDs. Max 100 allowed per request. Truncating.`);
        broadcasterIds = broadcasterIds.slice(0, 100);
    }

    const client = getHelixClient(); // Ensures client is initialized
    const params = new URLSearchParams();
    broadcasterIds.forEach(id => params.append('user_id', id));

    logger.debug({ broadcasterIds }, 'Fetching live stream information from Helix...');

    try {
        const response = await retryWithBackoff(async () => {
            return await client.get('/streams', { params });
        }, 2, 500); // Shorter retry for stream checks
        
        // Spec: https://dev.twitch.tv/docs/api/reference/#get-streams
        // Data is expected in response.data.data - only returns live streams
        return response.data?.data || [];
    } catch (error) {
        // Errors are already logged by the response interceptor
        logger.error({ err: { message: error.message, code: error.code } , broadcasterIds }, `Failed to get live stream information for IDs: ${broadcasterIds.join(',')}`);
        // Return empty array for graceful degradation
        return [];
    }
}

/**
 * Fetches shared chat session information for a broadcaster.
 * @param {string} broadcasterId - The broadcaster user ID to query.
 * @returns {Promise<object|null>} A promise resolving to the shared chat session object or null if not in a session.
 *                                  Session object contains: session_id, host_broadcaster_id, participants array
 */
async function getSharedChatSession(broadcasterId) {
    if (!broadcasterId) {
        logger.warn('getSharedChatSession called with empty broadcaster ID.');
        return null;
    }

    const client = getHelixClient(); // Ensures client is initialized
    const params = new URLSearchParams();
    params.append('broadcaster_id', broadcasterId);

    logger.debug({ broadcasterId }, 'Fetching shared chat session information from Helix...');

    try {
        const response = await retryWithBackoff(async () => {
            return await client.get('/shared_chat/session', { params });
        }, 2, 500);
        
        // Spec: https://dev.twitch.tv/docs/api/reference#get-shared-chat-session
        // Returns session data if channel is in a shared chat session
        const sessionData = response.data?.data?.[0] || null;
        
        if (sessionData) {
            logger.info({ 
                broadcasterId, 
                sessionId: sessionData.session_id,
                participantCount: sessionData.participants?.length || 0
            }, 'Channel is in shared chat session');
        } else {
            logger.debug({ broadcasterId }, 'Channel is not in a shared chat session');
        }
        
        return sessionData;
    } catch (error) {
        // If the channel is not in a shared chat session, the API returns 404
        if (error.response?.status === 404) {
            logger.debug({ broadcasterId }, 'Channel is not in a shared chat session (404)');
            return null;
        }
        
        // Other errors are already logged by the response interceptor
        logger.error({ 
            err: { message: error.message, code: error.code }, 
            broadcasterId 
        }, 'Failed to get shared chat session information');
        
        // Return null for graceful degradation
        return null;
    }
}


// Export initializer, getter, and specific API call functions
export {
    initializeHelixClient,
    getHelixClient,
    getChannelInformation,
    getUsersByLogin,
    getLiveStreams,
    getSharedChatSession,
};

// Helper: get ad schedule with broadcaster user token
export async function getAdScheduleForBroadcaster(broadcasterId, userAccessToken, clientId) {
    if (!broadcasterId || !userAccessToken || !clientId) {
        throw new Error('Missing params for getAdScheduleForBroadcaster');
    }
    try {
        const response = await axios.get(`${TWITCH_HELIX_URL}/channels/ads`, {
            params: { broadcaster_id: String(broadcasterId) },
            headers: {
                Authorization: `Bearer ${userAccessToken}`,
                'Client-ID': clientId,
            },
            timeout: 15000,
        });
        return response.data;
    } catch (error) {
        logger.error({ err: { message: error.message, code: error.code }, broadcasterId }, 'Failed to get ad schedule');
        throw error;
    }
}