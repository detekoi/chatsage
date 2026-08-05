// src/components/timers/timerManager.js
// Runs per-channel timed messages ("timers"). Each timer fires when its
// interval has elapsed, the stream is live, and enough chat lines have been
// seen since it last fired. Text timers resolve $(...) variables; prompt
// timers generate a fresh message via the LLM with stream + chat context.

import logger from '../../lib/logger.js';
import { enqueueMessage } from '../../lib/ircSender.js';
import { defaultPrefetchCache } from '../../lib/prefetchCache.js';
import { getContextManager } from '../context/contextManager.js';
import { getMessageCount } from '../context/channelActivity.js';
import { isStreamLive } from '../context/liveStatus.js';
import { parseVariables, formatDuration } from '../customCommands/variableParser.js';
import { resolvePrompt } from '../customCommands/promptResolver.js';
import { timerSource } from '../llm/inferenceHistoryStorage.js';
import {
    loadAllTimers,
    listenForTimerChanges,
    recordTimerRun,
    DEFAULT_INTERVAL_MINUTES,
    DEFAULT_MIN_CHAT_LINES,
} from './timersStorage.js';

const TICK_MS = 60 * 1000;
// Offset the first tick so timer ticks interleave between auto-chat ticks
// instead of both loops evaluating channels in the same instant.
const START_DELAY_MS = 25 * 1000;
const PREFETCH_LEAD_MS = 3 * 60 * 1000; // 3 minutes prefetch lead time

let startTimeoutId = null;
let intervalId = null;
let unsubscribeListener = null;
let tickInProgress = false;

// Timer definitions, written only by loadAllTimers() and the snapshot listener.
const configCache = new Map(); // channelName -> Map<timerName, timerDoc>

// Firing state, written only by the tick loop. Kept separate from configCache
// so the bot's own lastRunAt Firestore writes echoing back through the
// listener never clobber in-flight runtime state.
const runtime = new Map(); // channelName -> Map<timerName, { lastRunAtMs, lastSeenMessageCount, lastPrefetchAtMs }>

function getTimerPrefetchKey(channelName, timerName) {
    return `timer:${channelName}:${timerName}`;
}

function getChannelRuntime(channelName) {
    if (!runtime.has(channelName)) runtime.set(channelName, new Map());
    return runtime.get(channelName);
}

function seedRuntime(channelName, timer) {
    const channelRuntime = getChannelRuntime(channelName);
    if (channelRuntime.has(timer.name)) return;
    channelRuntime.set(timer.name, {
        lastRunAtMs: timer.lastRunAt?.toMillis ? timer.lastRunAt.toMillis() : 0,
        lastSeenMessageCount: getMessageCount(channelName),
        lastPrefetchAtMs: 0,
    });
}

function handleTimerChange({ type, channelName, timerName, timer }) {
    defaultPrefetchCache.clear(getTimerPrefetchKey(channelName, timerName));

    if (type === 'removed') {
        configCache.get(channelName)?.delete(timerName);
        runtime.get(channelName)?.delete(timerName);
        logger.debug(`[TimerManager] Timer ${timerName} removed for ${channelName}`);
        return;
    }
    if (!configCache.has(channelName)) configCache.set(channelName, new Map());
    configCache.get(channelName).set(timerName, timer);
    if (type === 'added') {
        seedRuntime(channelName, timer);
    }
    logger.debug(`[TimerManager] Timer ${timerName} ${type} for ${channelName}`);
}

function isEligible(channelName, timer, nowMs) {
    if (timer.enabled === false) return false;
    const state = getChannelRuntime(channelName).get(timer.name);
    if (!state) return false;

    const intervalMs = (timer.intervalMinutes || DEFAULT_INTERVAL_MINUTES) * 60 * 1000;
    if (nowMs - state.lastRunAtMs < intervalMs) return false;

    const minLines = timer.minChatLines ?? DEFAULT_MIN_CHAT_LINES;
    if (getMessageCount(channelName) - state.lastSeenMessageCount < minLines) return false;

    return true;
}

async function generatePromptTimerOutput(channelName, timer, resolvedText) {
    const contextManager = getContextManager();
    const botLanguage = contextManager.getBotLanguage(channelName);
    const llmContext = contextManager.getContextForLLM(channelName, 'system', 'timer');

    const contextParts = [];
    if (llmContext?.streamGame && llmContext.streamGame !== 'N/A') contextParts.push(`Game: ${llmContext.streamGame}`);
    if (llmContext?.streamTitle) contextParts.push(`Title: ${llmContext.streamTitle}`);
    if (llmContext?.streamStartedAt) {
        contextParts.push(`Uptime: ${formatDuration(Date.now() - new Date(llmContext.streamStartedAt).getTime())}`);
    }
    const streamContextString = contextParts.length ? contextParts.join(' | ') : null;

    return await resolvePrompt(resolvedText, botLanguage || null, streamContextString, false, {
        channel: channelName,
        source: timerSource(timer.name),
        chatContext: llmContext?.recentChatHistory || null,
        serviceTier: 'flex',
    });
}

async function fireTimer(channelName, timer) {
    const contextManager = getContextManager();
    const channelRuntime = getChannelRuntime(channelName);

    // Advance runtime before any slow work so a failed/slow LLM call
    // can't cause the same timer to re-fire on the next tick.
    channelRuntime.set(timer.name, {
        lastRunAtMs: Date.now(),
        lastSeenMessageCount: getMessageCount(channelName),
        lastPrefetchAtMs: 0, // Reset prefetch tracking for the next interval
    });

    const streamContext = contextManager.getStreamContextSnapshot(channelName);
    const resolvedText = await parseVariables(timer.response, {
        user: '',
        channel: channelName,
        args: [],
        useCount: timer.useCount || 0,
        streamContext,
    });

    let finalOutput = resolvedText;
    let skipTranslation = false;

    if (timer.type === 'prompt') {
        const key = getTimerPrefetchKey(channelName, timer.name);
        const fetcher = () => generatePromptTimerOutput(channelName, timer, resolvedText);

        finalOutput = await defaultPrefetchCache.getOrAwait(key, fetcher, 10000);

        if (!finalOutput) {
            // Unsolicited message — nobody is waiting on a reply, so skip silently.
            logger.warn({ channel: channelName, timer: timer.name },
                '[TimerManager] LLM returned no response for prompt timer, skipping this run');
            return;
        }

        const botLanguage = contextManager.getBotLanguage(channelName);
        if (botLanguage) {
            skipTranslation = true;
        }
    }

    if (!finalOutput || !finalOutput.trim()) {
        logger.warn({ channel: channelName, timer: timer.name },
            '[TimerManager] Timer resolved to empty text, skipping this run');
        return;
    }

    // Re-check: the timer may have been deleted or disabled during generation.
    const current = configCache.get(channelName)?.get(timer.name);
    if (!current || current.enabled === false) {
        logger.debug(`[TimerManager] Timer ${timer.name} deleted/disabled mid-fire in ${channelName}, dropping message`);
        return;
    }
    
    // Re-check: the stream might have gone offline during LLM generation.
    if (!isStreamLive(channelName)) {
        logger.debug(`[TimerManager] Stream went offline mid-fire in ${channelName}, dropping message`);
        return;
    }

    await enqueueMessage(`#${channelName}`, finalOutput, { skipTranslation });
    recordTimerRun(channelName, timer.name);
    logger.info(`[TimerManager] Fired timer ${timer.name} in ${channelName} (type: ${timer.type || 'text'})`);
}

async function tick() {
    if (tickInProgress) {
        logger.warn('[TimerManager] Tick skipped due to previous tick still running (LLM delay)');
        return;
    }
    tickInProgress = true;
    try {
        const nowMs = Date.now();
        const contextManager = getContextManager();

        for (const [channelName, timers] of configCache) {
            try {
                if (timers.size === 0) continue;
                if (!isStreamLive(channelName)) {
                    defaultPrefetchCache.clearPrefix(`timer:${channelName}:`);
                    continue;
                }

                // Check for upcoming prompt timers that should be pre-cached on Flex tier
                for (const timer of timers.values()) {
                    if (timer.type !== 'prompt' || timer.enabled === false) continue;
                    const state = getChannelRuntime(channelName).get(timer.name);
                    if (!state) continue;

                    const intervalMs = (timer.intervalMinutes || DEFAULT_INTERVAL_MINUTES) * 60 * 1000;
                    const prefetchLead = Math.min(intervalMs / 2, PREFETCH_LEAD_MS);
                    const nextRunAtMs = state.lastRunAtMs ? state.lastRunAtMs + intervalMs : 0;
                    const msUntilRun = nextRunAtMs - nowMs;
                    const prefetchedRecently = state.lastPrefetchAtMs && (nowMs - state.lastPrefetchAtMs < intervalMs);

                    const key = getTimerPrefetchKey(channelName, timer.name);
                    if (nextRunAtMs > 0 && msUntilRun > 0 && msUntilRun <= prefetchLead && !prefetchedRecently && !defaultPrefetchCache.has(key)) {
                        state.lastPrefetchAtMs = nowMs;
                        logger.info({ channel: channelName, timer: timer.name, msUntilRun }, '[TimerManager] 🔄 Prefetching prompt timer on Flex tier...');
                        const streamContext = contextManager.getStreamContextSnapshot(channelName);
                        parseVariables(timer.response, {
                            user: '',
                            channel: channelName,
                            args: [],
                            useCount: timer.useCount || 0,
                            streamContext,
                        }).then((resolvedText) => {
                            defaultPrefetchCache.prefetch(key, () => generatePromptTimerOutput(channelName, timer, resolvedText), intervalMs);
                        }).catch((err) => {
                            logger.warn({ err, channel: channelName, timer: timer.name }, '[TimerManager] Error parsing variables during prefetch');
                        });
                    }
                }

                const eligible = [...timers.values()].filter(t => isEligible(channelName, t, nowMs));
                if (eligible.length === 0) continue;

                // Fire at most one timer per channel per tick (longest-starved first)
                // so multiple due timers never post back-to-back.
                eligible.sort((a, b) => {
                    const channelRuntime = getChannelRuntime(channelName);
                    return (channelRuntime.get(a.name)?.lastRunAtMs || 0) - (channelRuntime.get(b.name)?.lastRunAtMs || 0);
                });
                
                await Promise.race([
                    fireTimer(channelName, eligible[0]),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('fireTimer timeout exceeded')), 30000))
                ]);
            } catch (err) {
                logger.error({ err, channel: channelName }, '[TimerManager] Error processing channel during tick');
            }
        }
    } finally {
        tickInProgress = false;
    }
}

export async function startTimerManager() {
    if (intervalId || startTimeoutId) {
        logger.warn('[TimerManager] Already running');
        return;
    }
    logger.info('[TimerManager] Starting...');

    const allTimers = await loadAllTimers();
    for (const [channelName, timers] of allTimers) {
        configCache.set(channelName, timers);
        for (const timer of timers.values()) {
            seedRuntime(channelName, timer);
        }
    }

    unsubscribeListener = listenForTimerChanges(handleTimerChange);

    startTimeoutId = setTimeout(() => {
        startTimeoutId = null;
        tick();
        intervalId = setInterval(tick, TICK_MS);
    }, START_DELAY_MS);

    logger.info(`[TimerManager] Started with timers for ${configCache.size} channels`);
}

export function stopTimerManager() {
    if (startTimeoutId) {
        clearTimeout(startTimeoutId);
        startTimeoutId = null;
    }
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }
    if (unsubscribeListener) {
        unsubscribeListener();
        unsubscribeListener = null;
    }
    defaultPrefetchCache.clearAll();
    configCache.clear();
    runtime.clear();
    logger.info('[TimerManager] Stopped');
}

// Exported for testing only
export { tick as _tick, fireTimer as _fireTimer, handleTimerChange as _handleTimerChange };
export function _getRuntime() { return runtime; }
export function _getConfigCache() { return configCache; }
