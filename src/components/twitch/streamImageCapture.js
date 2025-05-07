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
    // Standard Twitch thumbnail URL format with cache busting
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
export async function getCurrentGameInfo(channelName) {
    try {
        // Get context for LLM which should have stream info
        const contextManager = getContextManager();
        const streamContext = contextManager.getContextForLLM(channelName, 'system', 'game info lookup');
        
        if (!streamContext) {
            logger.info({ channel: channelName }, 'No stream context available');
            return null;
        }
        
        // Extract game info from context
        const gameName = streamContext.streamGame || 'Unknown';
        const streamTitle = streamContext.streamTitle || 'Unknown';
        
        // Check if we have viewer count in the context
        let viewerCount = 0;
        if (streamContext.viewerCount && !isNaN(parseInt(streamContext.viewerCount))) {
            viewerCount = parseInt(streamContext.viewerCount);
        }
        
        const result = {
            gameName: gameName !== 'N/A' ? gameName : 'Unknown',
            streamTitle: streamTitle !== 'N/A' ? streamTitle : 'Unknown',
            viewerCount: viewerCount
        };
        
        logger.debug({ 
            channel: channelName,
            gameInfo: result
        }, 'Retrieved game info from context');
        
        return result;
        
    } catch (error) {
        logger.error({ err: error, channel: channelName }, 'Error fetching current game info');
        return null;
    }
}