// src/components/twitch/botTokenHelper.js
// Retrieves a user access token for the bot account itself.
// Needed for Helix endpoints that reject app access tokens, such as chat announcements.
// The refresh token comes from the TWITCH_BOT_REFRESH_TOKEN secret (scripts/get-user-token.js).

import axios from 'axios';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';

const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const TOKEN_EXPIRY_BUFFER_MS = 60 * 1000; // Treat tokens as expired 60s early

let cachedToken = null; // { accessToken, expiresAt }
let refreshPromise = null; // Prevents concurrent refreshes
let currentRefreshToken = null; // Tracks rotation for the life of the instance

async function _refreshBotToken() {
    const refreshToken = currentRefreshToken || config.twitch.botRefreshToken;
    if (!refreshToken) {
        logger.debug('[BotTokenHelper] No bot refresh token configured');
        return null;
    }

    try {
        const body = new URLSearchParams({
            client_id: config.twitch.clientId,
            client_secret: config.twitch.clientSecret,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
        });

        const response = await axios.post(TWITCH_TOKEN_URL, body.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 15000,
        });

        const { access_token: accessToken, refresh_token: newRefreshToken, expires_in: expiresIn = 3600 } = response.data;
        if (!accessToken) {
            logger.error('[BotTokenHelper] Token refresh returned no access token');
            return null;
        }

        if (newRefreshToken && newRefreshToken !== refreshToken) {
            // Twitch does not normally rotate refresh tokens for confidential clients.
            // Keep the new one in memory; the secret still holds the original.
            logger.warn('[BotTokenHelper] Bot refresh token rotated by Twitch; using the new token in memory only');
            currentRefreshToken = newRefreshToken;
        }

        cachedToken = {
            accessToken,
            expiresAt: Date.now() + (expiresIn * 1000) - TOKEN_EXPIRY_BUFFER_MS,
        };
        return accessToken;
    } catch (error) {
        const status = error.response?.status;
        logger.error({
            err: { message: error.message, status, responseData: error.response?.data },
        }, '[BotTokenHelper] Failed to refresh bot access token');
        return null;
    }
}

/**
 * Returns a valid user access token for the bot account, refreshing it when needed.
 * @returns {Promise<string|null>} The access token, or null if unavailable.
 */
export async function getBotAccessToken() {
    if (cachedToken && cachedToken.expiresAt > Date.now()) {
        return cachedToken.accessToken;
    }
    if (!refreshPromise) {
        refreshPromise = _refreshBotToken().finally(() => {
            refreshPromise = null;
        });
    }
    return refreshPromise;
}

/**
 * Evicts the cached bot access token so the next call refreshes it.
 * Call after a 401 from an endpoint that used the token.
 */
export function clearCachedBotToken() {
    cachedToken = null;
}

/** Resets all module state. For test isolation. */
export function _resetBotTokenState() {
    cachedToken = null;
    refreshPromise = null;
    currentRefreshToken = null;
}
