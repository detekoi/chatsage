// src/components/twitch/chatClient.js
// Handles sending chat messages via Twitch Helix API
// Replaces the outbound functionality of the old IRC client

import config from '../../config/index.js';
import logger from '../../lib/logger.js';
import { getUsersByLogin, sendAnnouncement as helixSendAnnouncement, sendChatMessage as helixSendChatMessage } from './helixClient.js';
import { getBroadcasterAccessToken, clearCachedBroadcasterToken, clearAllCachedBroadcasterTokens } from './broadcasterTokenHelper.js';
import { getBotAccessToken, clearCachedBotToken, _resetBotTokenState } from './botTokenHelper.js';

// Cache for the bot's user ID
let cachedBotUserId = null;

// Cache for broadcaster IDs keyed by channel name (used by app-token fallback)
const broadcasterIdCache = new Map();

export function _resetCache() {
    cachedBotUserId = null;
    broadcasterIdCache.clear();
    clearAllCachedBroadcasterTokens();
    _resetBotTokenState();
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
        const [broadcasterId, botId] = await Promise.all([
            _getBroadcasterId(cleanChannelName),
            getBotUserId(),
        ]);
        if (!broadcasterId) {
            logger.error({ channelName: cleanChannelName }, 'Could not find broadcaster ID for channel');
            return false;
        }
        if (!botId) {
            logger.error('Could not determine Bot User ID');
            return false;
        }

        const result = await helixSendChatMessage(broadcasterId, botId, message, options.replyToId);

        if (result?.is_sent === false) {
            logger.warn({
                channel: cleanChannelName,
                message,
                dropReason: result.drop_reason
            }, 'Message was not sent (dropped by Twitch)');
            return false;
        }
        if (result?.is_sent !== true) {
            logger.warn({ channel: cleanChannelName, response: result ?? null },
                'Twitch did not confirm the message was sent');
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
 * Used by sendMessage and the bot-token path in sendAnnouncement.
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
 * Announcements appear with a colored highlight bar in chat, attributed to
 * whichever user is passed as moderator_id. The endpoint requires a user
 * access token; app access tokens are rejected with 401.
 *
 * Two authorization paths:
 *
 * 1. **Primary — Bot token**: The bot's own user access token (from the
 *    TWITCH_BOT_REFRESH_TOKEN secret) with the bot as moderator_id, so the
 *    announcement shows as coming from the bot. Requires the bot to be a
 *    moderator in the channel.
 *
 * 2. **Fallback — Broadcaster token**: The broadcaster's user access token
 *    (moderator:manage:announcements from the web UI OAuth) with
 *    moderator_id = broadcaster_id. The announcement shows as coming from
 *    the broadcaster. Covers channels where the bot is not a moderator.
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
        // Primary path: bot's own user access token, bot as moderator
        const botAccessToken = await getBotAccessToken();
        if (botAccessToken) {
            const [broadcasterId, botId] = await Promise.all([
                _getBroadcasterId(cleanChannelName),
                getBotUserId(),
            ]);
            if (broadcasterId && botId) {
                const result = await helixSendAnnouncement(broadcasterId, botId, message, botAccessToken, color);
                if (result.success) {
                    logger.info({ channel: cleanChannelName, color, message: message.substring(0, 50) },
                        'Sent announcement via bot token');
                    return true;
                }
                // 401 means the token expired or was revoked; 403 usually means
                // the bot is not a moderator in this channel
                if (result.status === 401) {
                    clearCachedBotToken();
                }
                logger.warn({ channel: cleanChannelName, status: result.status },
                    'Bot token announcement failed, trying broadcaster token');
            }
        }

        // Fallback path: broadcaster's own user access token
        const broadcasterAuth = await getBroadcasterAccessToken(cleanChannelName);
        if (!broadcasterAuth) {
            logger.warn({ channel: cleanChannelName }, 'No token available to send announcement');
            return false;
        }

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
                'Broadcaster token auth failed, evicted cache.');
        }
        return false;
    } catch (error) {
        logger.error({
            err: error.response ? error.response.data : error.message,
            channel: cleanChannelName,
        }, 'Error sending announcement via Helix');
        return false;
    }
}

