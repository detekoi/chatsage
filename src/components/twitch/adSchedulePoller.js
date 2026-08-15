import logger from '../../lib/logger.js';
import { getContextManager } from '../context/contextManager.js';
import { notifyAdSoon, generateAdNotification } from '../autoChat/autoChatManager.js';
import { getChannelAutoChatConfig } from '../context/autoChatStorage.js';
import config from '../../config/index.js';
import { getSecretValue } from '../../lib/secretManager.js';
import { isCloudTasksEnabled, scheduleTask, cancelTask, buildTaskId } from '../../lib/cloudTasks.js';
import { isStreamLive } from '../context/liveStatus.js';

// How far ahead of the ad break the warning is sent.
const PRE_ROLL_MS = 60_000;
// Tasks are delivered this much earlier than the warning so a cold start and
// the LLM call still leave time to post at the right moment.
const COLD_START_BUDGET_MS = 20_000;
// The channel.ad_break.begin subscription — the only source of manual "ads are
// running now" announcements — is created by the dashboard when the ads toggle
// is switched on, and Twitch revokes it whenever the broadcaster's
// authorization changes. Nothing recreated it, so re-assert it from here.
const ADBREAK_ENSURE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ADBREAK_ENSURE_RETRY_MS = 10 * 60 * 1000;
// Returned when the schedule lookup itself failed, as opposed to succeeding with
// no ad scheduled. The two need different handling: an empty schedule means any
// pending warning is stale, but a failed lookup says nothing about the ad, and
// tearing the timer down there would drop the warning for good — the ad is
// already in notifiedAds, so no later tick would reschedule it.
const FETCH_FAILED = Symbol('ad-schedule-fetch-failed');

let timers = new Map(); // channel -> NodeJS.Timeout
let prefetchTimers = new Map(); // channel -> NodeJS.Timeout (for prefetch)
let intervalId = null; // background poll
let notifiedAds = new Map(); // channel -> Set of ad timestamps we've already notified about
let prefetchedMessages = new Map(); // channel -> prefetched message text
let scheduledAdAt = new Map(); // channel -> ad timestamp of the pending Cloud Task
let adBreakEnsuredAt = new Map(); // channel -> epoch ms the ad_break subscription was last confirmed

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
            return FETCH_FAILED;
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
            // Don't throw on auth errors, just skip this channel
            return FETCH_FAILED;
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

        // Don't throw, so the remaining channels still get processed
        return FETCH_FAILED;
    }
}

/**
 * Re-asserts the channel.ad_break.begin EventSub subscription for a channel that
 * has ad notifications enabled.
 *
 * The web UI owns this because creating the subscription needs an app access
 * token plus proof that the broadcaster granted channel:read:ads, and it holds
 * both. Without the subscription the scheduled pre-roll warning still fires
 * (it comes from the ad schedule endpoint) but manually started ad breaks are
 * announced nowhere.
 *
 * @param {string} channelName
 */
async function ensureAdBreakSubscription(channelName) {
    if (Date.now() - (adBreakEnsuredAt.get(channelName) || 0) < ADBREAK_ENSURE_INTERVAL_MS) return;

    if (!config.webui?.baseUrl || !config.webui?.internalToken) return;

    // Hold off the next attempt before making the call so a failing endpoint is
    // not retried on every 30s tick.
    adBreakEnsuredAt.set(channelName, Date.now() - ADBREAK_ENSURE_INTERVAL_MS + ADBREAK_ENSURE_RETRY_MS);

    try {
        const internalToken = await getSecretValue(config.webui.internalToken);
        if (!internalToken) {
            throw new Error('Failed to retrieve internal bot token from Secret Manager');
        }

        const axios = (await import('axios')).default;
        await axios.post(
            `${config.webui.baseUrl}/internal/eventsub/adbreak/ensure`,
            { channelLogin: channelName, adsEnabled: true },
            { headers: { 'Authorization': `Bearer ${internalToken}` }, timeout: 15000 }
        );

        adBreakEnsuredAt.set(channelName, Date.now());
        logger.debug({ channelName }, '[AdSchedule] channel.ad_break.begin subscription confirmed');
    } catch (e) {
        logger.warn({
            channelName,
            error: e.message,
            status: e.response?.status
        }, '[AdSchedule] Could not confirm channel.ad_break.begin subscription — manual ad breaks may go unannounced');
    }
}

function clearTimer(channelName) {
    const t = timers.get(channelName);
    if (t) { clearTimeout(t); timers.delete(channelName); }
    const p = prefetchTimers.get(channelName);
    if (p) { clearTimeout(p); prefetchTimers.delete(channelName); }
    prefetchedMessages.delete(channelName);
}

/**
 * Enqueues a durable Cloud Task carrying the pre-ad warning.
 *
 * Unlike a setTimeout, the task survives this instance being scaled to zero:
 * Cloud Tasks holds it and delivers it over HTTP at the scheduled time, cold
 * starting the service if nothing is running.
 *
 * @param {string} channelName
 * @param {number} adAtMs - Epoch ms of the ad break itself
 * @returns {Promise<{scheduled: boolean, duplicate?: boolean, reason?: string}>}
 */
async function scheduleAdNotificationTask(channelName, adAtMs) {
    // Drop any task still pending for a superseded ad time on this channel.
    const previous = scheduledAdAt.get(channelName);
    if (previous && previous !== adAtMs) {
        await cancelTask(buildTaskId('ad', channelName, previous));
    }

    // Deliver early enough that a cold start plus the LLM call still finish
    // before the warning is due.
    const deliverAtMs = Math.max(Date.now() + 1_000, adAtMs - PRE_ROLL_MS - COLD_START_BUDGET_MS);

    const result = await scheduleTask({
        taskId: buildTaskId('ad', channelName, adAtMs),
        payload: { kind: 'ad-notification', channelName, adAtMs },
        deliverAtMs,
    });

    if (result.scheduled || result.duplicate) {
        scheduledAdAt.set(channelName, adAtMs);
    }
    return result;
}

/**
 * Local-dev fallback for when Cloud Tasks is not configured. Keeps the
 * original in-process behaviour: a prefetch timer followed by a send timer.
 */
function scheduleAdNotificationInProcess(channelName, nextAd, fireIn, adTimestamp, channelNotifiedAds) {
    const PREFETCH_LEAD_MS = 45_000;
    const prefetchIn = Math.max(0, fireIn - PREFETCH_LEAD_MS);

    prefetchTimers.set(channelName, setTimeout(async () => {
        try {
            logger.info({ channelName }, '[AdSchedule] 🔄 Prefetching ad notification message...');
            const text = await generateAdNotification(channelName, 'warning', 60);
            if (text) {
                prefetchedMessages.set(channelName, text);
                logger.info({ channelName, textLength: text.length }, '[AdSchedule] ✓ Ad notification prefetched successfully');
            } else {
                logger.warn({ channelName }, '[AdSchedule] Prefetch returned no text, will fall back to live generation');
            }
        } catch (e) {
            logger.warn({ err: e, channelName }, '[AdSchedule] Prefetch failed, will fall back to live generation');
        }
    }, prefetchIn));

    timers.set(channelName, setTimeout(async () => {
        try {
            // Use prefetched message if available, otherwise notifyAdSoon will generate live
            const cachedText = prefetchedMessages.get(channelName) || null;
            prefetchedMessages.delete(channelName);

            logger.info({
                channelName,
                expectedAdAt: nextAd.toISOString(),
                usedPrefetch: !!cachedText
            }, '[AdSchedule] 📢 Sending pre-ad notification now (60s warning)');

            await notifyAdSoon(channelName, 60, cachedText);
            logger.info({ channelName }, '[AdSchedule] ✓ Pre-ad notification sent successfully');
        } catch (e) {
            logger.error({ err: e, channelName }, '[AdSchedule] ✗ Pre-alert failed');
            // Remove from notified set on failure so it can retry
            channelNotifiedAds.delete(adTimestamp);
        }
    }, fireIn));
}

/**
 * Handles a delivered ad-notification Cloud Task.
 *
 * The task may have been queued 40 minutes ago on an instance that no longer
 * exists, so every precondition is re-checked here rather than trusted from
 * the payload.
 *
 * @param {Object} payload
 * @param {string} payload.channelName
 * @param {number} payload.adAtMs - Epoch ms of the ad break
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
export async function handleAdNotificationTask({ channelName, adAtMs } = {}) {
    if (!channelName || !Number.isFinite(adAtMs)) {
        throw new Error('[AdSchedule] ad-notification task missing channelName or adAtMs');
    }

    scheduledAdAt.delete(channelName);

    const cfg = await getChannelAutoChatConfig(channelName);
    if (!cfg || cfg.categories?.ads !== true) {
        logger.info({ channelName }, '[AdSchedule] Task delivered but ads are disabled, dropping');
        return { sent: false, reason: 'ads-disabled' };
    }

    if (!isStreamLive(channelName)) {
        logger.info({ channelName }, '[AdSchedule] Task delivered but stream is offline, dropping');
        return { sent: false, reason: 'stream-offline' };
    }

    if (adAtMs - Date.now() <= 0) {
        logger.warn({ channelName, adAt: new Date(adAtMs).toISOString() },
            '[AdSchedule] Task delivered after the ad break had already started, dropping');
        return { sent: false, reason: 'too-late' };
    }

    // Generate first, then hold until the warning is actually due. Doing it in
    // this order keeps a slow cold start from pushing the message past its lead.
    let text = null;
    try {
        text = await generateAdNotification(channelName, 'warning', Math.round(PRE_ROLL_MS / 1000));
    } catch (e) {
        logger.warn({ err: e, channelName }, '[AdSchedule] Generation failed, notifyAdSoon will retry live');
    }

    const waitMs = adAtMs - PRE_ROLL_MS - Date.now();
    if (waitMs > 0) {
        await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, COLD_START_BUDGET_MS)));
    }

    const secondsUntil = Math.max(1, Math.round((adAtMs - Date.now()) / 1000));
    logger.info({
        channelName,
        adAt: new Date(adAtMs).toISOString(),
        secondsUntil,
        usedPrefetch: !!text
    }, '[AdSchedule] 📢 Sending pre-ad notification now');

    await notifyAdSoon(channelName, secondsUntil, text);
    logger.info({ channelName }, '[AdSchedule] ✓ Pre-ad notification sent successfully');
    return { sent: true };
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
            logger.debug({ channelCount }, '[AdSchedule] Poller tick - checking channels');

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
                // Manual ad breaks arrive over EventSub rather than the schedule
                // endpoint, so the subscription has to exist even on ticks where
                // no scheduled ad is pending.
                await ensureAdBreakSubscription(channelName);
                // Fetch schedule via web UI
                try {
                    const adScheduleData = await fetchAdScheduleViaWebUI(channelName);
                    if (adScheduleData === FETCH_FAILED) {
                        // Leave any pending warning in place — it is still the best
                        // information we have about the next ad.
                        logger.debug({ channelName }, '[AdSchedule] Schedule lookup failed, keeping the pending notification');
                        continue;
                    }
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

                    const fireIn = Math.max(0, msUntil - PRE_ROLL_MS);
                    const fireAt = new Date(Date.now() + fireIn);
                    logger.info({
                        channelName,
                        nextAdAt: nextAd.toISOString(),
                        secondsUntilAd: Math.floor(msUntil / 1000),
                        notificationWillFireAt: fireAt.toISOString(),
                        secondsUntilNotification: Math.floor(fireIn / 1000),
                        durable: isCloudTasksEnabled()
                    }, '[AdSchedule] 🔔 Ad notification scheduled');

                    // Mark as notified IMMEDIATELY when scheduling (prevents race condition with next poller tick)
                    channelNotifiedAds.add(adTimestamp);

                    // Clear existing timers before scheduling new ones
                    clearTimer(channelName);

                    if (isCloudTasksEnabled()) {
                        const result = await scheduleAdNotificationTask(channelName, adTimestamp);
                        if (!result.scheduled && !result.duplicate) {
                            // Nothing durable is pending, so allow a later tick to retry.
                            channelNotifiedAds.delete(adTimestamp);
                        }
                    } else {
                        scheduleAdNotificationInProcess(channelName, nextAd, fireIn, adTimestamp, channelNotifiedAds);
                    }
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
    for (const t of prefetchTimers.values()) { clearTimeout(t); }
    prefetchTimers.clear();
    prefetchedMessages.clear();
    notifiedAds.clear();
    adBreakEnsuredAt.clear();
    // Pending Cloud Tasks are deliberately left in the queue: they outlive this
    // process by design, and handleAdNotificationTask re-validates on delivery.
    scheduledAdAt.clear();
}
