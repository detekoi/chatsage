import logger from '../../lib/logger.js';
import config from '../../config/index.js';
import { getContextManager } from '../context/contextManager.js';
import { notifyAdSoon } from '../autoChat/autoChatManager.js';
import { getUsersByLogin } from './helixClient.js';
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
        } catch (_) {}
    }
    if (!base) throw new Error('WEBUI_BASE_URL not set');
    if (!token) throw new Error('WEBUI_INTERNAL_TOKEN not set');
    if (/\.web\.app$|\.firebaseapp\.com$/.test(new URL(base).host)) {
        logger.warn({ base }, '[AdSchedule] WEBUI_BASE_URL appears to be a Hosting domain; internal Functions routes may not be accessible. Use the Functions base URL instead.');
    }
    const url = `${base}/internal/ads/schedule`;
    const headers = { Authorization: `Bearer ${token}` };
    const res = await axios.get(url, { headers, timeout: 15000, params: { channel: channelName } });
    return res.data?.data || null;
}

function clearTimer(channelName) {
    const t = timers.get(channelName);
    if (t) { clearTimeout(t); timers.delete(channelName); }
}

export async function startAdSchedulePoller() {
    if (intervalId) return intervalId;
    intervalId = setInterval(async () => {
        try {
            const contextManager = getContextManager();
            for (const [channelName] of contextManager.getAllChannelStates()) {
                // Only if live
                const ctx = contextManager.getContextForLLM(channelName, 'system', 'ad-schedule');
                const isLive = !!(ctx && ctx.streamGame && ctx.streamGame !== 'N/A');
                if (!isLive) { clearTimer(channelName); logger.debug({ channelName }, '[AdSchedule] Skipping - stream offline'); continue; }
                // Only if ads on
                const cfg = await getChannelAutoChatConfig(channelName);
                if (!cfg || cfg.mode === 'off' || cfg.categories?.ads !== true) { clearTimer(channelName); logger.debug({ channelName }, '[AdSchedule] Skipping - ads disabled'); continue; }
                // Fetch schedule (web-ui proxy uses broadcaster’s user token)
                try {
                    const data = await fetchAdScheduleFromWebUi(channelName);
                    const schedule = data?.data?.[0];
                    const nextAd = schedule?.next_ad_at ? new Date(schedule.next_ad_at) : null;
                    if (!nextAd) { clearTimer(channelName); logger.debug({ channelName }, '[AdSchedule] No next_ad_at'); continue; }
                    const msUntil = nextAd.getTime() - Date.now();
                    if (msUntil <= 0) { clearTimer(channelName); logger.debug({ channelName }, '[AdSchedule] next_ad_at already passed'); continue; }
                    const fireIn = Math.max(5_000, msUntil - 60_000); // 60s before
                    // If a timer exists but significantly different, reset
                    clearTimer(channelName);
                    timers.set(channelName, setTimeout(async () => {
                        try { logger.info({ channelName }, '[AdSchedule] Pre-alert firing ~60s before ad'); await notifyAdSoon(channelName, 60); } catch (e) { logger.error({ err: e, channelName }, '[AdSchedule] Pre-alert failed'); }
                    }, fireIn));
                } catch (e) {
                    logger.debug({ err: e?.message, channelName }, '[AdSchedule] fetch failed');
                }
            }
        } catch (err) {
            logger.error({ err }, '[AdSchedule] Poller tick error');
        }
    }, 30_000);
    return intervalId;
}

export function stopAdSchedulePoller() {
    if (intervalId) { clearInterval(intervalId); intervalId = null; }
    for (const [ch, t] of timers) { clearTimeout(t); }
    timers.clear();
}


