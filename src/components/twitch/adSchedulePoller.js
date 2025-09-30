import logger from '../../lib/logger.js';
import { getContextManager } from '../context/contextManager.js';
import { notifyAdSoon } from '../autoChat/autoChatManager.js';
import axios from 'axios';
import { getSecretValue, initializeSecretManager } from '../../lib/secretManager.js';
import { getChannelAutoChatConfig } from '../context/autoChatStorage.js';

let timers = new Map(); // channel -> NodeJS.Timeout
let intervalId = null; // background poll

async function fetchAdScheduleFromWebUi(channelName) {
    const base = process.env.WEBUI_BASE_URL || process.env.CHATSAGE_WEBUI_BASE_URL;
    let token = process.env.WEBUI_INTERNAL_TOKEN || '';
    // If value looks like a Secret Manager path, resolve it once
    if (/^projects\/.+\/secrets\//.test(token)) {
        try {
            // Normalize to versions/latest if not provided
            if (!/\/versions\//.test(token)) {
                token = `${token}/versions/latest`;
            }
            initializeSecretManager();
            token = (await getSecretValue(token)) || '';
        } catch (e) { /* ignore */ }
    }
    if (!base) throw new Error('WEBUI_BASE_URL not set');
    if (!token) throw new Error('WEBUI_INTERNAL_TOKEN not set');
    if (/\.web\.app$|\.firebaseapp\.com$/.test(new URL(base).host)) {
        logger.warn({ base }, '[AdSchedule] WEBUI_BASE_URL appears to be a Hosting domain; internal Functions routes may not be accessible. Use the Functions base URL instead.');
    }
    const url = `${base}/internal/ads/schedule`;
    const headers = { Authorization: `Bearer ${token}` };
    const res = await axios.get(url, { headers, timeout: 15000, params: { channel: channelName } });
    
    // Log the full response for debugging
    logger.debug({ channelName, response: res.data }, '[AdSchedule] Web UI response');
    
    // Log raw HTTP response for troubleshooting
    logger.debug({ 
        channelName, 
        status: res.status,
        headers: res.headers,
        dataKeys: res.data ? Object.keys(res.data) : []
    }, '[AdSchedule] Raw response details');
    
    // Validate response structure
    if (!res.data || !res.data.success) {
        logger.warn({ channelName, response: res.data }, '[AdSchedule] Web UI returned unsuccessful response');
        return null;
    }
    
    // The Twitch API returns ad schedule in response.data.data as an array
    const twitchApiData = res.data.data;
    if (!twitchApiData) {
        logger.debug({ channelName }, '[AdSchedule] No Twitch API data in response');
        return null;
    }
    
    // The data field is an array, get the first element
    const adScheduleData = Array.isArray(twitchApiData) ? twitchApiData[0] : twitchApiData;
    if (!adScheduleData) {
        logger.debug({ channelName }, '[AdSchedule] No ad schedule data in array');
        return null;
    }
    
    // Log the ad schedule data for debugging
    logger.debug({ channelName, adScheduleData }, '[AdSchedule] Parsed ad schedule data');
    
    return adScheduleData;
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
                // Fetch schedule (web-ui proxy uses broadcaster's user token)
                try {
                    const adScheduleData = await fetchAdScheduleFromWebUi(channelName);
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
                    logger.debug({
                        channelName,
                        nextAdAt: nextAd.toISOString(),
                        msUntil,
                        fireIn
                    }, '[AdSchedule] Scheduling ad notification');

                    // If a timer exists but significantly different, reset
                    clearTimer(channelName);
                    timers.set(channelName, setTimeout(async () => {
                        try {
                            logger.info({ channelName }, '[AdSchedule] Pre-alert firing ~60s before ad');
                            await notifyAdSoon(channelName, 60);
                        } catch (e) {
                            logger.error({ err: e, channelName }, '[AdSchedule] Pre-alert failed');
                        }
                    }, fireIn));
                } catch (e) {
                    const status = e?.response?.status;
                    const data = e?.response?.data;
                    const errorMessage = e?.response?.data?.message || e?.message;
                    
                    // Log detailed error information
                    logger.error({
                        channelName,
                        status,
                        data,
                        err: e?.message,
                        errorMessage,
                        stack: e?.stack
                    }, '[AdSchedule] fetch failed');
                    
                    // Check if this is an authentication issue
                    if (status === 401 || status === 403 || errorMessage?.includes('re-authenticate') || errorMessage?.includes('Refresh token not available') || errorMessage?.includes('Missing required scope') || errorMessage?.includes('Invalid OAuth token')) {
                        logger.warn({ 
                            channelName, 
                            status,
                            errorMessage 
                        }, '[AdSchedule] ⚠️  AUTHENTICATION REQUIRED: Channel needs to re-authenticate with Twitch to enable ad notifications. User must visit the dashboard and reconnect to grant the channel:read:ads scope.');
                    } else if (status === 404) {
                        logger.warn({ channelName }, '[AdSchedule] Channel not found in web UI database. User may need to add the bot first.');
                    } else if (status >= 500) {
                        logger.error({ channelName, status, errorMessage }, '[AdSchedule] Web UI server error. Check web UI logs for details.');
                    } else {
                        logger.error({ channelName, status, errorMessage }, '[AdSchedule] Unexpected error fetching ad schedule.');
                    }
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