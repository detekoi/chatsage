// src/components/twitch/streamImageCapture.js
import axios from 'axios';
import logger from '../../lib/logger.js';
import { getContextManager } from '../context/contextManager.js';

/**
 * Constructs a standard Twitch thumbnail URL for a channel
 * @param {string} channelName - The name of the Twitch channel
 * @returns {string} The constructed thumbnail URL with cache busting
 */
function constructThumbnailUrl(channelName) {
    // Revert to higher resolution thumbnail now that the image model is stable
    return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${channelName}-1280x720.jpg?t=${Date.now()}`;
}

/**
 * Fetches the thumbnail image for a specific channel
 * @param {string} channelName - The name of the Twitch channel
 * @returns {Promise<Buffer|null>} The thumbnail image as a Buffer or null if failed
 */
export async function fetchStreamThumbnail(channelName) {
    try {
        // Construct standard thumbnail URL
        const thumbnailUrl = constructThumbnailUrl(channelName);
        
        // Fetch the image
        const response = await axios.get(thumbnailUrl, { 
            responseType: 'arraybuffer',
            // Set a timeout to avoid hanging
            timeout: 5000,
            // Handle 404 errors gracefully
            validateStatus: status => status < 500
        });
        
        // Check if we got a successful response
        if (response.status !== 200) {
            logger.warn({ 
                channel: channelName, 
                status: response.status 
            }, 'Failed to fetch thumbnail, channel may be offline');
            return null;
        }
        
        const imageBuffer = Buffer.from(response.data, 'binary');
        
        logger.debug({ 
            channel: channelName, 
            imageSize: imageBuffer.length 
        }, 'Successfully fetched stream thumbnail');
        
        return imageBuffer;
    } catch (error) {
        logger.error({ err: error, channel: channelName }, 'Error fetching stream thumbnail');
        return null;
    }
}

/**
 * Gets the current game information from context
 * @param {string} channelName - The name of the Twitch channel
 * @returns {Promise<Object|null>} Game information object or null if failed
 */
// getCurrentGameInfo moved to streamInfoPoller.js to centralize stream info lookups