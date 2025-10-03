import logger from '../../lib/logger.js';
import { getContextManager } from '../context/contextManager.js';
import { notifyAdSoon } from '../autoChat/autoChatManager.js';
import { getAdScheduleForBroadcaster } from './helixClient.js';
import { Firestore } from '@google-cloud/firestore';
import { getSecretValue, setSecretValue, initializeSecretManager } from '../../lib/secretManager.js';
import { getChannelAutoChatConfig } from '../context/autoChatStorage.js';
import config from '../../config/index.js';

let timers = new Map(); // channel -> NodeJS.Timeout
let intervalId = null; // background poll
let db = null; // Firestore instance

// Token cache to minimize Secret Manager and Twitch API calls
const tokenCache = new Map(); // channelName -> { accessToken, expiresAt }

function getDb() {
    if (!db) {
        db = new Firestore();
    }
    return db;
}

async function getValidTokenForChannel(channelName) {
    // Check cache first - only caching short-lived access tokens, NOT refresh tokens
    const cached = tokenCache.get(channelName);
    if (cached && cached.expiresAt > Date.now()) {
        const ttlSeconds = Math.floor((cached.expiresAt - Date.now()) / 1000);
        logger.debug({ channelName, ttlSeconds }, '[AdSchedule] Using cached access token');
        return cached;
    }

    // Fetch metadata from Firestore (only contains references, not secrets)
    try {
        const firestore = getDb();
        const channelDoc = await firestore.collection('managedChannels').doc(channelName).get();

        if (!channelDoc.exists) {
            throw new Error(`Channel ${channelName} not found in database`);
        }

        const data = channelDoc.data();
        const { twitchUserId, refreshTokenSecretPath, needsTwitchReAuth } = data;

        if (needsTwitchReAuth) {
            throw new Error(`Channel ${channelName} needs to re-authenticate with Twitch`);
        }

        if (!refreshTokenSecretPath) {
            throw new Error(`No refresh token secret path found for ${channelName}`);
        }

        if (!twitchUserId) {
            throw new Error(`No Twitch user ID found for ${channelName}`);
        }

        // Get refresh token from Secret Manager (secure storage)
        // Note: We never cache the refresh token, only retrieve it when needed
        initializeSecretManager();
        const refreshToken = await getSecretValue(refreshTokenSecretPath);

        if (!refreshToken) {
            throw new Error(`Failed to retrieve refresh token from Secret Manager for ${channelName}`);
        }

        // Exchange refresh token for short-lived access token
        const axios = (await import('axios')).default;
        logger.debug({
            channelName,
            refreshTokenPrefix: refreshToken.substring(0, 8) + '...',
            refreshTokenSuffix: '...' + refreshToken.substring(refreshToken.length - 8)
        }, '[AdSchedule] Exchanging refresh token for access token');

        const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
            params: {
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: config.twitch.clientId,
                client_secret: config.twitch.clientSecret,
            },
            timeout: 10000,
        });

        const accessToken = response.data.access_token;
        const newRefreshToken = response.data.refresh_token;
        const expiresIn = response.data.expires_in || 3600;

        // CRITICAL: Twitch rotates refresh tokens on every use
        // We MUST save the new refresh token back to Secret Manager
        if (newRefreshToken && newRefreshToken !== refreshToken) {
            logger.info({
                channelName,
                oldTokenPrefix: refreshToken.substring(0, 8) + '...',
                newTokenPrefix: newRefreshToken.substring(0, 8) + '...'
            }, '[AdSchedule] 🔄 Refresh token rotated by Twitch, updating Secret Manager');

            const updateSuccess = await setSecretValue(refreshTokenSecretPath, newRefreshToken);
            if (!updateSuccess) {
                logger.error({ channelName, refreshTokenSecretPath }, '[AdSchedule] ❌ CRITICAL: Failed to save new refresh token to Secret Manager. Next refresh will fail!');
                // Don't throw - we still have a valid access token for now
            } else {
                logger.info({ channelName }, '[AdSchedule] ✅ New refresh token saved to Secret Manager');
            }
        } else if (!newRefreshToken) {
            logger.warn({ channelName }, '[AdSchedule] ⚠️  Twitch did not return a new refresh token (unexpected)');
        } else {
            logger.debug({ channelName }, '[AdSchedule] Refresh token unchanged (reusing same token)');
        }

        // Only cache the short-lived access token (safe to cache in memory)
        // These tokens expire in ~1 hour and can't be used to obtain new tokens
        const expiresAt = Date.now() + ((expiresIn - 300) * 1000); // 5-minute buffer
        tokenCache.set(channelName, { accessToken, broadcasterId: twitchUserId, expiresAt });

        logger.info({
            channelName,
            expiresIn,
            cacheDuration: Math.floor((expiresIn - 300) / 60) + 'min',
            tokenRotated: newRefreshToken && newRefreshToken !== refreshToken
        }, '[AdSchedule] ✓ Obtained fresh access token');
        return { accessToken, broadcasterId: twitchUserId, expiresAt };
    } catch (error) {
        // Clear cache on error
        tokenCache.delete(channelName);

        // Enhanced error logging
        const isInvalidToken = error.response?.status === 400 &&
            error.response?.data?.message?.includes('Invalid refresh token');
        const errorDetails = {
            channelName,
            error: error.message,
            status: error.response?.status,
            twitchError: error.response?.data?.message,
            isInvalidToken
        };

        if (isInvalidToken) {
            logger.error(errorDetails, '[AdSchedule] ❌ Invalid refresh token - user needs to re-authenticate via web UI');
            // Mark in Firestore that re-auth is needed
            try {
                const firestore = getDb();
                await firestore.collection('managedChannels').doc(channelName).update({
                    needsTwitchReAuth: true,
                    lastTokenError: 'Invalid refresh token',
                    lastTokenErrorAt: new Date()
                });
                logger.info({ channelName }, '[AdSchedule] Marked channel as needing re-authentication in Firestore');
            } catch (dbError) {
                logger.warn({ channelName, err: dbError }, '[AdSchedule] Failed to update Firestore re-auth flag');
            }
        } else {
            logger.error(errorDetails, '[AdSchedule] Failed to get valid token');
        }

        throw error;
    }
}

async function fetchAdScheduleDirectly(channelName, retryCount = 0) {
    const MAX_RETRIES = 2;
    const RETRY_DELAYS = [1000, 3000]; // Exponential backoff: 1s, 3s

    try {
        logger.debug({ channelName, attempt: retryCount + 1 }, '[AdSchedule] Starting ad schedule fetch');

        // Get valid access token for this channel
        const { accessToken, broadcasterId } = await getValidTokenForChannel(channelName);

        logger.debug({ channelName, broadcasterId, attempt: retryCount + 1 }, '[AdSchedule] Calling Twitch API');

        // Call Twitch API directly
        const result = await getAdScheduleForBroadcaster(broadcasterId, accessToken, config.twitch.clientId);

        // Extract ad schedule data from response
        const adScheduleData = result?.data?.[0];

        if (!adScheduleData) {
            logger.debug({ channelName, fullResponse: result }, '[AdSchedule] No ad schedule data in Twitch response');
            return null;
        }

        logger.info({ channelName, nextAdAt: adScheduleData.next_ad_at }, '[AdSchedule] ✓ Successfully fetched ad schedule');
        return adScheduleData;

    } catch (e) {
        const isTimeout = e.code === 'ECONNABORTED' || e.message?.includes('timeout');
        const isServerError = e.response?.status >= 500;
        const isAuthError = e.response?.status === 401 || e.response?.status === 403;
        const isMissingScope = e.response?.data?.message?.includes('Missing required scope') ||
                               e.response?.data?.message?.includes('channel:read:ads');
        const canRetry = (isTimeout || isServerError) && retryCount < MAX_RETRIES;

        if (isAuthError || isMissingScope) {
            // Clear token cache on auth error
            tokenCache.delete(channelName);
            const errorMessage = e.response?.data?.message || e.message;
            logger.warn({
                channelName,
                status: e.response?.status,
                errorMessage
            }, '[AdSchedule] ⚠️  AUTHENTICATION REQUIRED: Channel needs to re-authenticate with Twitch to enable ad notifications. User must visit the dashboard and reconnect to grant the channel:read:ads scope.');
            // Don't throw on auth errors, just return null to skip this channel
            return null;
        }

        if (canRetry) {
            const delay = RETRY_DELAYS[retryCount];
            logger.warn({
                channelName,
                attempt: retryCount + 1,
                nextAttemptIn: `${delay}ms`,
                error: e.message,
                isTimeout,
                isServerError
            }, '[AdSchedule] Request failed, retrying...');

            await new Promise(resolve => setTimeout(resolve, delay));
            return fetchAdScheduleDirectly(channelName, retryCount + 1);
        }

        // Log other errors
        logger.error({
            channelName,
            error: e.message,
            status: e.response?.status,
            data: e.response?.data
        }, '[AdSchedule] Failed to fetch ad schedule after retries');

        // Don't throw, return null to continue processing other channels
        return null;
    }
}

function clearTimer(channelName) {
    const t = timers.get(channelName);
    if (t) { clearTimeout(t); timers.delete(channelName); }
}

export function startAdSchedulePoller() {
    if (intervalId) return intervalId;
    // This function now returns the intervalId so it can be cleared.
    // It also uses unref() to allow the Node.js process to exit even if the timer is active.
    intervalId = setInterval(async () => {
        try {
            const contextManager = getContextManager();
            for (const [channelName, state] of contextManager.getAllChannelStates()) {
                // Only if live - check stream context directly
                const isLive = !!(state.streamContext?.game && state.streamContext.game !== 'N/A' && state.streamContext.game !== null);
                logger.debug({
                    channelName,
                    streamGame: state.streamContext?.game,
                    isLive
                }, '[AdSchedule] Checking channel status');
                if (!isLive) { clearTimer(channelName); logger.debug({ channelName }, '[AdSchedule] Skipping - stream offline'); continue; }
                // Only if ads on
                const cfg = await getChannelAutoChatConfig(channelName);
                logger.debug({
                    channelName,
                    config: cfg,
                    adsEnabled: cfg?.categories?.ads
                }, '[AdSchedule] Checking ads configuration');
                if (!cfg || cfg.mode === 'off' || cfg.categories?.ads !== true) { clearTimer(channelName); logger.debug({ channelName }, '[AdSchedule] Skipping - ads disabled'); continue; }
                // Fetch schedule directly from Twitch API
                try {
                    const adScheduleData = await fetchAdScheduleDirectly(channelName);
                    if (!adScheduleData) {
                        clearTimer(channelName);
                        logger.debug({ channelName }, '[AdSchedule] No ad schedule data');
                        continue;
                    }

                    // Handle timestamp format - could be RFC3339 string or Unix timestamp
                    const nextAdAt = adScheduleData.next_ad_at;
                    if (!nextAdAt) {
                        clearTimer(channelName);
                        logger.debug({ channelName }, '[AdSchedule] No next_ad_at in response');
                        continue;
                    }

                    // Parse timestamp - handle both RFC3339 and Unix timestamp formats
                    let nextAd;
                    if (typeof nextAdAt === 'string') {
                        // Try RFC3339 first, fall back to Unix timestamp
                        nextAd = new Date(nextAdAt);
                        if (isNaN(nextAd.getTime())) {
                            // Might be Unix timestamp as string
                            const unixTime = parseInt(nextAdAt, 10);
                            if (!isNaN(unixTime)) {
                                nextAd = new Date(unixTime * 1000);
                            }
                        }
                    } else if (typeof nextAdAt === 'number') {
                        // Unix timestamp as number
                        nextAd = new Date(nextAdAt * 1000);
                    }

                    if (!nextAd || isNaN(nextAd.getTime())) {
                        clearTimer(channelName);
                        logger.warn({ channelName, nextAdAt }, '[AdSchedule] Invalid next_ad_at format');
                        continue;
                    }

                    const msUntil = nextAd.getTime() - Date.now();
                    if (msUntil <= 0) {
                        clearTimer(channelName);
                        logger.debug({ channelName, nextAdAt: nextAd.toISOString() }, '[AdSchedule] next_ad_at already passed');
                        continue;
                    }

                    const fireIn = Math.max(5_000, msUntil - 60_000); // 60s before
                    const fireAt = new Date(Date.now() + fireIn);
                    logger.info({
                        channelName,
                        nextAdAt: nextAd.toISOString(),
                        secondsUntilAd: Math.floor(msUntil / 1000),
                        notificationWillFireAt: fireAt.toISOString(),
                        secondsUntilNotification: Math.floor(fireIn / 1000)
                    }, '[AdSchedule] 🔔 Ad notification scheduled');

                    // If a timer exists but significantly different, reset
                    clearTimer(channelName);
                    timers.set(channelName, setTimeout(async () => {
                        try {
                            logger.info({ 
                                channelName,
                                expectedAdAt: nextAd.toISOString(),
                                secondsUntilAd: Math.floor((nextAd.getTime() - Date.now()) / 1000)
                            }, '[AdSchedule] 📢 Sending pre-ad notification now (60s warning)');
                            await notifyAdSoon(channelName, 60);
                            logger.info({ channelName }, '[AdSchedule] ✓ Pre-ad notification sent successfully');
                        } catch (e) {
                            logger.error({ err: e, channelName }, '[AdSchedule] ✗ Pre-alert failed');
                        }
                    }, fireIn));
                } catch (e) {
                    // Errors are already logged in fetchAdScheduleDirectly
                    logger.debug({ channelName, err: e.message }, '[AdSchedule] Skipping channel due to error');
                }
            }
        } catch (err) {
            logger.error({ err }, '[AdSchedule] Poller tick error');
        }
    }, 30_000);

    if (intervalId.unref) {
        intervalId.unref();
    }
    return intervalId;
}

export function stopAdSchedulePoller() {
    if (intervalId) { clearInterval(intervalId); intervalId = null; }
    for (const t of timers.values()) { clearTimeout(t); }
    timers.clear();
}