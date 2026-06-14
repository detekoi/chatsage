// src/components/twitch/chatClient.js
// Handles sending chat messages via Twitch Helix API
// Replaces the outbound functionality of the old IRC client

import axios from 'axios';
import config from '../../config/index.js';
import logger from '../../lib/logger.js';
import { getUsersByLogin, sendAnnouncement as helixSendAnnouncement } from './helixClient.js';
import { getAppAccessToken } from './auth.js';

// Cache for the bot's user ID
let cachedBotUserId = null;

// Cache for broadcaster IDs keyed by channel name
const broadcasterIdCache = new Map();

export function _resetCache() {
    cachedBotUserId = null;
    broadcasterIdCache.clear();
}

/**
 * Helper to get the Bot's User ID using its access token
 */
export async function getBotUserId() {
    if (cachedBotUserId) return cachedBotUserId;
    try {
        const users = await getUsersByLogin([config.twitch.username]);
        if (users && users.length > 0) {
            cachedBotUserId = users[0].id;
            return cachedBotUserId;
        }
        return null;
    } catch (error) {
        logger.error({ err: error }, 'WildcatSage: Error fetching bot user ID.');
        return null;
    }
}

/**
 * Sends a chat message to a specific channel using the Helix API
 * Uses App Access Token (requires user:bot scope on the bot user,
 * and either moderator status or channel:bot scope from the broadcaster)
 *
 * @param {string} channelName - The name of the channel to send to
 * @param {string} message - The message text to send
 * @param {object} [options] - Optional parameters
 * @param {string} [options.replyToId] - Message ID to reply to
 * @returns {Promise<boolean>} - True if successful, false otherwise
 */
export async function sendMessage(channelName, message, options = {}) {
    if (!channelName || !message) {
        logger.warn('sendMessage called with missing channel or message');
        return false;
    }

    // Clean channel name (remove # if present)
    const cleanChannelName = channelName.replace(/^#/, '').toLowerCase();

    try {
        // Get App Access Token
        const appAccessToken = await getAppAccessToken();
        if (!appAccessToken) {
            logger.error('App access token not available - cannot send chat messages');
            return false;
        }

        // Get the broadcaster ID for the target channel
        const users = await getUsersByLogin([cleanChannelName]);
        if (!users || users.length === 0) {
            logger.error({ channelName: cleanChannelName }, 'Could not find broadcaster ID for channel');
            return false;
        }
        const broadcasterId = users[0].id;

        // Get the bot's user ID (sender)
        const botId = await getBotUserId();
        if (!botId) {
            logger.error('Could not determine Bot User ID');
            return false;
        }

        // Build request body
        const requestBody = {
            broadcaster_id: broadcasterId,
            sender_id: botId,
            message: message
        };

        // Add reply_parent_message_id if provided
        if (options.replyToId) {
            requestBody.reply_parent_message_id = options.replyToId;
        }

        // Send the message using App Access Token
        // Docs: https://dev.twitch.tv/docs/api/reference/#send-chat-message
        const response = await axios.post(
            'https://api.twitch.tv/helix/chat/messages',
            requestBody,
            {
                headers: {
                    'Authorization': `Bearer ${appAccessToken}`,
                    'Client-Id': config.twitch.clientId,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );

        const { is_sent, drop_reason } = response.data?.data?.[0] || {};

        if (is_sent === false) {
            logger.warn({
                channel: cleanChannelName,
                message,
                dropReason: drop_reason
            }, 'Message was not sent (dropped by Twitch)');
            return false;
        }

        logger.info({ channel: cleanChannelName, message: message.substring(0, 50) }, 'Sent chat message via Helix');
        return true;

    } catch (error) {
        logger.error({
            err: error.response ? error.response.data : error.message,
            channel: cleanChannelName
        }, 'Error sending chat message via Helix');
        return false;
    }
}

/**
 * Resolves a channel name to a broadcaster ID, with caching.
 * @param {string} cleanChannelName - Lowercase channel name without '#'
 * @returns {Promise<string|null>} The broadcaster ID, or null if not found
 */
async function _getBroadcasterId(cleanChannelName) {
    const cached = broadcasterIdCache.get(cleanChannelName);
    if (cached) return cached;

    const users = await getUsersByLogin([cleanChannelName]);
    if (!users || users.length === 0) return null;

    const id = users[0].id;
    broadcasterIdCache.set(cleanChannelName, id);
    return id;
}

/**
 * Sends an announcement to a specific channel using the Helix API.
 * Announcements appear with a colored highlight bar in chat.
 *
 * @param {string} channelName - The name of the channel to send to
 * @param {string} message - The announcement text (max 500 characters)
 * @param {string} [color='primary'] - Highlight color: 'blue', 'green', 'orange', 'purple', or 'primary'
 * @returns {Promise<boolean>} - True if successful, false otherwise
 */
export async function sendAnnouncement(channelName, message, color = 'primary') {
    if (!channelName || !message) {
        logger.warn('sendAnnouncement called with missing channel or message');
        return false;
    }

    const cleanChannelName = channelName.replace(/^#/, '').toLowerCase();

    try {
        // Resolve broadcaster ID and bot ID in parallel
        const [broadcasterId, botId] = await Promise.all([
            _getBroadcasterId(cleanChannelName),
            getBotUserId(),
        ]);

        if (!broadcasterId) {
            logger.error({ channelName: cleanChannelName }, 'Could not find broadcaster ID for announcement');
            return false;
        }
        if (!botId) {
            logger.error('Could not determine Bot User ID for announcement');
            return false;
        }

        const success = await helixSendAnnouncement(broadcasterId, botId, message, color);

        if (success) {
            logger.info({ channel: cleanChannelName, color, message: message.substring(0, 50) }, 'Sent announcement via Helix');
        }

        return success;
    } catch (error) {
        logger.error({
            err: error.response ? error.response.data : error.message,
            channel: cleanChannelName,
        }, 'Error sending announcement via Helix');
        return false;
    }
}
