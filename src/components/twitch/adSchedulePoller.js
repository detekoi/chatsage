import logger from '../../lib/logger.js';
import config from '../../config/index.js';
import { getContextManager } from '../context/contextManager.js';
import { notifyAdSoon } from '../autoChat/autoChatManager.js';
import { getUsersByLogin } from './helixClient.js';
import axios from 'axios';
import { getChannelAutoChatConfig } from '../context/autoChatStorage.js';

let timers = new Map(); // channel -> NodeJS.Timeout
let intervalId = null; // background poll

async function fetchAdScheduleFromWebUi(channelName) {
    const base = process.env.WEBUI_BASE_URL || process.env.CHATSAGE_WEBUI_BASE_URL;
    const token = process.env.WEBUI_INTERNAL_TOKEN || '';
    if (!base) throw new Error('WEBUI_BASE_URL not set');
    const url = `${base}/api/ads/schedule`;
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await axios.get(url, { headers, timeout: 15000, params: {} });
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
                if (!isLive) { clearTimer(channelName); continue; }
                // Only if ads on
                const cfg = await getChannelAutoChatConfig(channelName);
                if (!cfg || cfg.mode === 'off' || cfg.categories?.ads !== true) { clearTimer(channelName); continue; }
                // Fetch schedule (web-ui proxy uses broadcaster’s user token)
                try {
                    const data = await fetchAdScheduleFromWebUi(channelName);
                    const schedule = data?.data?.[0];
                    const nextAd = schedule?.next_ad_at ? new Date(schedule.next_ad_at) : null;
                    if (!nextAd) { clearTimer(channelName); continue; }
                    const msUntil = nextAd.getTime() - Date.now();
                    if (msUntil <= 0) { clearTimer(channelName); continue; }
                    const fireIn = Math.max(5_000, msUntil - 60_000); // 60s before
                    // If a timer exists but significantly different, reset
                    clearTimer(channelName);
                    timers.set(channelName, setTimeout(async () => {
                        try { await notifyAdSoon(channelName, 60); } catch (_) {}
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


