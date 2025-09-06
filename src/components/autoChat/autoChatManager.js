import logger from '../../lib/logger.js';
import { enqueueMessage } from '../../lib/ircSender.js';
import { getContextManager } from '../context/contextManager.js';
import { getOrCreateChatSession, buildContextPrompt, generateSearchResponse, generateStandardResponse } from '../llm/geminiClient.js';
import { getChannelAutoChatConfig, DEFAULT_AUTO_CHAT_CONFIG } from '../context/autoChatStorage.js';

// AutoChatManager periodically scans channel state and emits context-aware messages

let intervalId = null;
const TICK_MS = 60 * 1000; // 1 minute cadence

// Internal per-channel runtime state (not persisted)
const runtime = new Map(); // channelName -> { lastMessageAtMs, lastAutoAtMs, lastGame, lastSummaryHash, greetedOnStart, lastQuestion }

function now() { return Date.now(); }

function getAggressivenessMinGapMinutes(mode) {
    switch ((mode || 'off').toLowerCase()) {
        case 'low': return 30;
        case 'medium': return 15;
        case 'high': return 7;
        default: return Infinity;
    }
}

function getState(channelName) {
    if (!runtime.has(channelName)) runtime.set(channelName, {});
    return runtime.get(channelName);
}

function hashString(s) {
    let h = 0; if (!s) return 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
    return h;
}

async function maybeSendGreeting(channelName) {
    // Greet once per stream start
    const cfg = await getChannelAutoChatConfig(channelName);
    if (cfg.mode === 'off' || cfg.categories.greetings !== true) return;
    const state = getState(channelName);
    if (state.greetedOnStart) return;
    const context = getContextManager().getContextForLLM(channelName, 'system', 'stream-online');
    if (!context) return;
    const contextPrompt = buildContextPrompt(context);
    const prompt = `The stream just went live. Write one warm, concise greeting for chat. ≤25 words.`;
    const text = await generateStandardResponse(contextPrompt, prompt) || await generateSearchResponse(contextPrompt, prompt);
    if (text) {
        await enqueueMessage(`#${channelName}`, text);
        state.greetedOnStart = true;
        state.lastAutoAtMs = now();
    }
}

async function maybeHandleGameChange(channelName, prevGame, newGame) {
    const cfg = await getChannelAutoChatConfig(channelName);
    if (cfg.mode === 'off' || cfg.categories.facts !== true) return;
    const minGapMin = getAggressivenessMinGapMinutes(cfg.mode);
    const state = getState(channelName);
    if (now() - (state.lastAutoAtMs || 0) < minGapMin * 60 * 1000) return;

    const context = getContextManager().getContextForLLM(channelName, 'system', 'game-change');
    const contextPrompt = buildContextPrompt(context);
    const prompt = `Streamer switched from ${prevGame || 'Unknown'} to ${newGame}. Provide one surprising fact or a super useful beginner tip about ${newGame}. ≤30 words.`;
    // Prefer grounded facts; require grounding to avoid hallucinated facts
    const text = await generateSearchResponse(contextPrompt, prompt, { requireGrounding: true })
        || await generateSearchResponse(contextPrompt, prompt)
        || await generateStandardResponse(contextPrompt, prompt);
    if (text) {
        await enqueueMessage(`#${channelName}`, text);
        state.lastAutoAtMs = now();
    }
}

async function maybeHandleLull(channelName) {
    const cfg = await getChannelAutoChatConfig(channelName);
    if (cfg.mode === 'off' || cfg.categories.questions !== true) return;
    const state = getState(channelName);
    const minGapMin = getAggressivenessMinGapMinutes(cfg.mode);
    // Detect lull: no message for X minutes depending on mode
    const lullThresholdMin = cfg.mode === 'high' ? 3 : cfg.mode === 'medium' ? 5 : 8;
    const lastMessageAtMs = state.lastMessageAtMs || 0;
    if (now() - lastMessageAtMs < lullThresholdMin * 60 * 1000) return;
    if (now() - (state.lastAutoAtMs || 0) < minGapMin * 60 * 1000) return;

    const context = getContextManager().getContextForLLM(channelName, 'system', 'lull');
    if (!context) return;
    const contextPrompt = buildContextPrompt(context);
    const topic = context.chatSummary || context.streamGame || 'the stream';
    const prompt = `Chat has been quiet. Based on the current topic "${topic}", ask ONE engaging, open-ended question to re-spark conversation. ≤20 words. Do not ask the same question as "${state.lastQuestion}"`;
    const text = await generateSearchResponse(contextPrompt, prompt, { requireGrounding: true });
    if (text) {
        await enqueueMessage(`#${channelName}`, text);
        state.lastAutoAtMs = now();
    }
}

async function maybeHandleTopicShift(channelName) {
    const cfg = await getChannelAutoChatConfig(channelName);
    if (cfg.mode === 'off' || cfg.categories.facts !== true) return;
    const state = getState(channelName);
    const context = getContextManager().getContextForLLM(channelName, 'system', 'topic-shift');
    if (!context) return;
    const summary = context.chatSummary || '';
    const currentHash = hashString(summary);
    if (state.lastSummaryHash === undefined) { state.lastSummaryHash = currentHash; return; }
    if (currentHash === state.lastSummaryHash) return; // no shift

    const minGapMin = getAggressivenessMinGapMinutes(cfg.mode);
    if (now() - (state.lastAutoAtMs || 0) < minGapMin * 60 * 1000) { state.lastSummaryHash = currentHash; return; }

    const contextPrompt = buildContextPrompt(context);
    const prompt = `The conversation topic changed. Provide ONE concise, interesting fact or helpful insight related to the new topic. ≤28 words. Do not repeat the fact: "${state.lastQuestion}"`;
    // Prefer grounded facts on topic shifts; require grounding first, then relax, then fallback
    const text = await generateSearchResponse(contextPrompt, prompt, { requireGrounding: true })
        || await generateSearchResponse(contextPrompt, prompt)
        || await generateStandardResponse(contextPrompt, prompt);
    if (text) {
        await enqueueMessage(`#${channelName}`, text);
        state.lastAutoAtMs = now();
    }
    state.lastSummaryHash = currentHash;
}

export function notifyUserMessage(channelName, timestampMs) {
    const state = getState(channelName);
    state.lastMessageAtMs = Math.max(state.lastMessageAtMs || 0, timestampMs || now());
}

export function notifyStreamOnline(channelName) {
    const state = getState(channelName);
    state.greetedOnStart = false;
}

export async function startAutoChatManager() {
    if (intervalId) {
        logger.warn('[AutoChatManager] Already running');
        return intervalId;
    }
    logger.info('[AutoChatManager] Starting...');
    const contextManager = getContextManager();
    // Prime lastMessageAt for known channels
    for (const [channelName, state] of contextManager.getAllChannelStates()) {
        const s = getState(channelName);
        const last = state.chatHistory?.[state.chatHistory.length - 1]?.timestamp;
        s.lastMessageAtMs = last ? new Date(last).getTime() : 0;
        s.lastAutoAtMs = 0;
        s.greetedOnStart = false;
        s.lastGame = state.streamContext?.game || null;
        s.lastSummaryHash = hashString(state.chatSummary || '');
    }

    intervalId = setInterval(async () => {
        try {
            for (const [channelName, state] of contextManager.getAllChannelStates()) {
                const cfg = await getChannelAutoChatConfig(channelName);
                if ((cfg.mode || 'off') === 'off') continue;

                // Stream must be live to auto-chat
                const ctx = contextManager.getContextForLLM(channelName, 'system', 'tick');
                const isLive = !!(ctx && ctx.streamGame && ctx.streamGame !== 'N/A');
                if (!isLive) continue;

                // Detect game change
                const currentGame = state.streamContext?.game || null;
                const prevGame = getState(channelName).lastGame;
                if (currentGame && prevGame && currentGame !== prevGame) {
                    await maybeHandleGameChange(channelName, prevGame, currentGame);
                }
                getState(channelName).lastGame = currentGame;

                // Greet on start (first tick while live)
                await maybeSendGreeting(channelName);

                // Topic shift detection
                await maybeHandleTopicShift(channelName);

                // Lull detection
                await maybeHandleLull(channelName);
            }
        } catch (err) {
            logger.error({ err }, '[AutoChatManager] Error during tick');
        }
    }, TICK_MS);

    return intervalId;
}

export function stopAutoChatManager() {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
        logger.info('[AutoChatManager] Stopped');
    }
}