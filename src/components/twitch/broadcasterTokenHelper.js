// src/components/twitch/broadcasterTokenHelper.js
// Retrieves valid broadcaster user access tokens for API calls requiring user-level scopes.
// Reads refresh tokens from Firestore and exchanges them via Twitch OAuth.

import axios from 'axios';
import { Firestore } from '@google-cloud/firestore';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';
import { getChannelInfo } from './channelManager.js';

const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const USERS_COLLECTION = 'users';
const PRIVATE_SUBCOLLECTION = 'private';
const OAUTH_DOC_ID = 'oauth';

// In-memory token cache: { [channelName]: { accessToken, expiresAt } }
const tokenCache = new Map();
const TOKEN_EXPIRY_BUFFER_MS = 60 * 1000; // Treat tokens as expired 60s early

/**
 * Gets the shared Firestore instance (same one used by channelManager).
 * Lazily initialized.
 */
let db = null;
function _getDb() {
    if (!db) {
        db = new Firestore();
    }
    return db;
}

/**
 * Returns a valid broadcaster user access token for the given channel.
 * Handles caching, refresh, and token rotation.
 *
 * @param {string} channelName - Channel name (without '#').
 * @returns {Promise<{accessToken: string, twitchUserId: string}|null>}
 *   The access token and user ID, or null if unavailable.
 */
export async function getBroadcasterAccessToken(channelName) {
    const lowerChannel = channelName.toLowerCase();

    // Check cache first
    const cached = tokenCache.get(lowerChannel);
    if (cached && cached.expiresAt > Date.now()) {
        return { accessToken: cached.accessToken, twitchUserId: cached.twitchUserId };
    }

    // Get the broadcaster's Twitch user ID from channelManager
    let channelInfo;
    try {
        channelInfo = await getChannelInfo(lowerChannel);
    } catch (error) {
        logger.error({ err: error, channel: lowerChannel },
            '[BroadcasterTokenHelper] Failed to get channel info');
        return null;
    }

    if (!channelInfo?.twitchUserId) {
        logger.warn({ channel: lowerChannel },
            '[BroadcasterTokenHelper] No twitchUserId found for channel');
        return null;
    }

    const twitchUserId = channelInfo.twitchUserId;

    // Read refresh token from Firestore
    const firestore = _getDb();
    let refreshToken;
    try {
        const oauthDocRef = firestore
            .collection(USERS_COLLECTION)
            .doc(twitchUserId)
            .collection(PRIVATE_SUBCOLLECTION)
            .doc(OAUTH_DOC_ID);
        const doc = await oauthDocRef.get();
        refreshToken = doc.data()?.twitchRefreshToken;
    } catch (error) {
        logger.error({ err: error, channel: lowerChannel, twitchUserId },
            '[BroadcasterTokenHelper] Failed to read refresh token from Firestore');
        return null;
    }

    if (!refreshToken) {
        logger.warn({ channel: lowerChannel, twitchUserId },
            '[BroadcasterTokenHelper] No refresh token found. Broadcaster needs to re-authenticate.');
        return null;
    }

    // Exchange refresh token for a new access token
    try {
        const response = await axios.post(TWITCH_TOKEN_URL, null, {
            params: {
                client_id: config.twitch.clientId,
                client_secret: config.twitch.clientSecret,
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
            },
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 15000,
        });

        const newAccessToken = response.data.access_token;
        const newRefreshToken = response.data.refresh_token;
        const expiresIn = response.data.expires_in || 3600;

        if (!newAccessToken) {
            logger.error({ channel: lowerChannel },
                '[BroadcasterTokenHelper] Token refresh returned no access token');
            return null;
        }

        // Handle refresh token rotation
        if (newRefreshToken && newRefreshToken !== refreshToken) {
            logger.info({ channel: lowerChannel },
                '[BroadcasterTokenHelper] Refresh token rotated by Twitch, updating Firestore');
            try {
                const oauthDocRef = firestore
                    .collection(USERS_COLLECTION)
                    .doc(twitchUserId)
                    .collection(PRIVATE_SUBCOLLECTION)
                    .doc(OAUTH_DOC_ID);
                await oauthDocRef.set({
                    twitchRefreshToken: newRefreshToken,
                    updatedAt: Firestore.FieldValue?.serverTimestamp?.() || new Date(),
                    updateReason: 'bot-token-rotation',
                }, { merge: true });
            } catch (storeError) {
                logger.error({ err: storeError, channel: lowerChannel },
                    '[BroadcasterTokenHelper] CRITICAL: Failed to save rotated refresh token');
                // Continue - still have a valid access token for this request
            }
        }

        // Cache the new access token
        tokenCache.set(lowerChannel, {
            accessToken: newAccessToken,
            twitchUserId,
            expiresAt: Date.now() + (expiresIn * 1000) - TOKEN_EXPIRY_BUFFER_MS,
        });

        logger.debug({ channel: lowerChannel, expiresIn },
            '[BroadcasterTokenHelper] Successfully obtained broadcaster access token');

        return { accessToken: newAccessToken, twitchUserId };
    } catch (error) {
        const status = error.response?.status;
        logger.error({
            err: { message: error.message, status },
            channel: lowerChannel,
        }, '[BroadcasterTokenHelper] Failed to refresh broadcaster token');

        // If 401/400, the refresh token is likely invalid - broadcaster needs to re-auth
        if (status === 400 || status === 401) {
            logger.warn({ channel: lowerChannel },
                '[BroadcasterTokenHelper] Refresh token appears invalid. Broadcaster must re-authenticate.');
        }

        return null;
    }
}

/**
 * Clears the cached token for a channel.
 * @param {string} channelName - Channel name.
 */
export function clearCachedBroadcasterToken(channelName) {
    tokenCache.delete(channelName.toLowerCase());
}
