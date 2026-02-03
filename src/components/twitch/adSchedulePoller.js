import logger from '../../lib/logger.js';
import { getContextManager } from '../context/contextManager.js';
import { notifyAdSoon } from '../autoChat/autoChatManager.js';
import { getChannelAutoChatConfig } from '../context/autoChatStorage.js';
import config from '../../config/index.js';
import { getSecretValue } from '../../lib/secretManager.js';

let timers = new Map(); // channel -> NodeJS.Timeout
let intervalId = null; // background poll
let notifiedAds = new Map(); // channel -> Set of ad timestamps we've already notified about

/**
 * Fetches the ad schedule for a channel by calling the web UI's internal API.
 * This centralizes all token management in the web UI, avoiding token rotation conflicts.
 */
async function fetchAdScheduleViaWebUI(channelName, retryCount = 0) {
    const MAX_RETRIES = 2;
    const RETRY_DELAYS = [1000, 3000]; // Exponential backoff: 1s, 3s

    try {
        logger.debug({ channelName, attempt: retryCount + 1 }, '[AdSchedule] Fetching ad schedule via web UI');

        // Check if web UI config is available
        if (!config.webui || !config.webui.baseUrl || !config.webui.internalToken) {
            logger.warn('[AdSchedule] Web UI configuration not available. Set WEBUI_BASE_URL and WEBUI_INTERNAL_TOKEN environment variables.');
            return null;
        }

        // Get the internal bot token for authentication
        const internalToken = await getSecretValue(config.webui.internalToken);
        if (!internalToken) {
            throw new Error('Failed to retrieve internal bot token from Secret Manager');
        }

        // Call the web UI's internal ad schedule endpoint
        const axios = (await import('axios')).default;
        const response = await axios.get(`${config.webui.baseUrl}/internal/ads/schedule`, {
            headers: {
                'Authorization': `Bearer ${internalToken}`
            },
            params: {
                channel: channelName
            },
            timeout: 15000
        });

        if (!response.data.success) {
            throw new Error(response.data.message || 'Web UI returned unsuccessful response');
        }

        // Extract ad schedule data from response
        const adScheduleData = response.data.data?.data?.[0];

        if (!adScheduleData) {
            logger.debug({ channelName, fullResponse: response.data }, '[AdSchedule] No ad schedule data in response');
            return null;
        }

        logger.info({ channelName, nextAdAt: adScheduleData.next_ad_at }, '[AdSchedule] ✓ Successfully fetched ad schedule');
        return adScheduleData;

    } catch (e) {
        const isTimeout = e.code === 'ECONNABORTED' || e.message?.includes('timeout');
        const isServerError = e.response?.status >= 500;
        const isAuthError = e.response?.status === 401 || e.response?.status === 403;
        const isMissingScope = e.response?.data?.details?.message?.includes('Missing required scope') ||
            e.response?.data?.details?.message?.includes('channel:read:ads');
        const canRetry = (isTimeout || isServerError) && retryCount < MAX_RETRIES;

        if (isAuthError || isMissingScope) {
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
            return fetchAdScheduleViaWebUI(channelName, retryCount + 1);
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
            const channelStates = contextManager.getAllChannelStates();
            const channelCount = Array.from(channelStates).length;
            logger.info({ channelCount }, '[AdSchedule] Poller tick - checking channels');

            for (const [channelName, state] of channelStates) {
                // Only if live - check stream context directly
                const isLive = !!(state.streamContext?.game && state.streamContext.game !== 'N/A' && state.streamContext.game !== null);
                logger.debug({
                    channelName,
                    streamGame: state.streamContext?.game,
                    isLive
                }, '[AdSchedule] Checking channel status');
                if (!isLive) { clearTimer(channelName); logger.debug({ channelName }, '[AdSchedule] Skipping - stream offline'); continue; }
                // Only if ads category enabled (independent of auto-chat mode)
                const cfg = await getChannelAutoChatConfig(channelName);
                logger.info({
                    channelName,
                    mode: cfg?.mode,
                    adsEnabled: cfg?.categories?.ads
                }, '[AdSchedule] Checking ads configuration for channel');
                if (!cfg || cfg.categories?.ads !== true) { clearTimer(channelName); logger.debug({ channelName }, '[AdSchedule] Skipping - ads disabled'); continue; }
                // Fetch schedule via web UI
                try {
                    const adScheduleData = await fetchAdScheduleViaWebUI(channelName);
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

                    // Check if we've already notified about this specific ad time
                    const adTimestamp = nextAd.getTime();
                    if (!notifiedAds.has(channelName)) {
                        notifiedAds.set(channelName, new Set());
                    }
                    const channelNotifiedAds = notifiedAds.get(channelName);

                    if (channelNotifiedAds.has(adTimestamp)) {
                        logger.debug({
                            channelName,
                            nextAdAt: nextAd.toISOString()
                        }, '[AdSchedule] Already notified about this ad - skipping');
                        continue;
                    }

                    // Clean up old ad timestamps (older than 10 minutes)
                    const tenMinutesAgo = Date.now() - 600_000;
                    for (const oldTimestamp of channelNotifiedAds) {
                        if (oldTimestamp < tenMinutesAgo) {
                            channelNotifiedAds.delete(oldTimestamp);
                        }
                    }

                    const fireIn = Math.max(0, msUntil - 60_000); // 60s before
                    const fireAt = new Date(Date.now() + fireIn);
                    logger.info({
                        channelName,
                        nextAdAt: nextAd.toISOString(),
                        secondsUntilAd: Math.floor(msUntil / 1000),
                        notificationWillFireAt: fireAt.toISOString(),
                        secondsUntilNotification: Math.floor(fireIn / 1000)
                    }, '[AdSchedule] 🔔 Ad notification scheduled');

                    // Mark as notified IMMEDIATELY when scheduling (prevents race condition with next poller tick)
                    channelNotifiedAds.add(adTimestamp);

                    // If a timer exists but significantly different, reset
                    clearTimer(channelName);
                    timers.set(channelName, setTimeout(async () => {
                        try {
                            // re-calculate actual remaining time
                            const remainingMs = nextAd.getTime() - Date.now();
                            const remainingSecs = Math.max(0, Math.round(remainingMs / 1000));

                            logger.info({
                                channelName,
                                expectedAdAt: nextAd.toISOString(),
                                secondsUntilAd: remainingSecs
                            }, `[AdSchedule] 📢 Sending pre-ad notification now (${remainingSecs}s warning)`);

                            await notifyAdSoon(channelName, remainingSecs);
                            logger.info({ channelName }, '[AdSchedule] ✓ Pre-ad notification sent successfully');
                        } catch (e) {
                            logger.error({ err: e, channelName }, '[AdSchedule] ✗ Pre-alert failed');
                            // Remove from notified set on failure so it can retry
                            channelNotifiedAds.delete(adTimestamp);
                        }
                    }, fireIn));
                } catch (e) {
                    // Errors are already logged in fetchAdScheduleViaWebUI
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
    notifiedAds.clear();
}
