// src/components/twitch/chatClient.js
// Handles sending chat messages via Twitch Helix API
// Replaces the outbound functionality of the old IRC client

import axios from 'axios';
import config from '../../config/index.js';
import logger from '../../lib/logger.js';
import { getUsersByLogin, sendAnnouncement as helixSendAnnouncement } from './helixClient.js';
import { getAppAccessToken } from './auth.js';
import { getBroadcasterAccessToken, clearCachedBroadcasterToken, clearAllCachedBroadcasterTokens } from './broadcasterTokenHelper.js';

// Cache for the bot's user ID
let cachedBotUserId = null;

// Cache for broadcaster IDs keyed by channel name (used by app-token fallback)
const broadcasterIdCache = new Map();

export function _resetCache() {
    cachedBotUserId = null;
    broadcasterIdCache.clear();
    clearAllCachedBroadcasterTokens();
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
 * Used by the app-token fallback path in sendAnnouncement.
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
 * Two authorization paths (per Twitch API docs):
 *
 * 1. **Primary — Broadcaster token**: Uses the broadcaster's own user access
 *    token (with moderator:manage:announcements from the web UI OAuth).
 *    The broadcaster is always a moderator of their own channel, so
 *    moderator_id = broadcaster_id.
 *
 * 2. **Fallback — App token + bot-as-moderator**: Uses the app access token
 *    with the bot (WildcatSage) as moderator_id. Requires the bot to have
 *    moderator:manage:announcements + user:bot scopes (from get-user-token.js)
 *    and mod status in the channel (or broadcaster granted channel:bot).
 *    Covers channels where the broadcaster hasn't completed OAuth.
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
        // Primary path: broadcaster's own user access token
        const broadcasterAuth = await getBroadcasterAccessToken(cleanChannelName);
        if (broadcasterAuth) {
            const { accessToken, twitchUserId: broadcasterId } = broadcasterAuth;
            const result = await helixSendAnnouncement(broadcasterId, broadcasterId, message, accessToken, color);
            if (result.success) {
                logger.info({ channel: cleanChannelName, color, message: message.substring(0, 50) },
                    'Sent announcement via broadcaster token');
                return true;
            }
            // On auth failure (401/403), the token is likely expired or revoked —
            // evict the cache so the next call re-fetches from Firestore/Twitch
            if (result.status === 401 || result.status === 403) {
                clearCachedBroadcasterToken(cleanChannelName);
                logger.warn({ channel: cleanChannelName, status: result.status },
                    'Broadcaster token auth failed, evicted cache. Trying app token fallback.');
            } else {
                logger.warn({ channel: cleanChannelName, status: result.status },
                    'Broadcaster token announcement failed, trying app token fallback');
            }
        }

        // Fallback path: app access token + bot as moderator
        // Works if bot has moderator:manage:announcements + user:bot scopes
        // and has mod status in the channel (or broadcaster granted channel:bot)
        const [broadcasterId, botId, appAccessToken] = await Promise.all([
            _getBroadcasterId(cleanChannelName),
            getBotUserId(),
            getAppAccessToken(),
        ]);

        if (!broadcasterId || !botId || !appAccessToken) {
            logger.error({
                channel: cleanChannelName,
                hasBroadcasterId: !!broadcasterId,
                hasBotId: !!botId,
                hasAppToken: !!appAccessToken,
            }, 'Missing required IDs for app-token announcement fallback');
            return false;
        }

        const fallbackResult = await helixSendAnnouncement(broadcasterId, botId, message, appAccessToken, color);
        if (fallbackResult.success) {
            logger.info({ channel: cleanChannelName, color, message: message.substring(0, 50) },
                'Sent announcement via app token fallback');
        }
        return fallbackResult.success;
    } catch (error) {
        logger.error({
            err: error.response ? error.response.data : error.message,
            channel: cleanChannelName,
        }, 'Error sending announcement via Helix');
        return false;
    }
}

