import logger from '../../lib/logger.js';
import { enqueueMessage } from '../../lib/ircSender.js';
import { getContextManager } from '../context/contextManager.js';
import { buildContextPrompt, generateSearchResponse, generateStandardResponse } from '../llm/geminiClient.js';
import { getChannelAutoChatConfig } from '../context/autoChatStorage.js';

// AutoChatManager periodically scans channel state and emits context-aware messages

let intervalId = null;
const TICK_MS = 60 * 1000; // 1 minute cadence

// Internal per-channel runtime state (not persisted)
const runtime = new Map(); // channelName -> { lastMessageAtMs, lastAutoAtMs, lastGame, lastSummaryHash, greetedOnStart, lastQuestion, lastAutoKind }

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

function choose(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function recordAutoText(state, text) {
    if (!state) return;
    if (typeof text === 'string' && /\?\s*$/.test(text)) {
        state.lastQuestion = text;
        state.lastAutoKind = 'question';
    } else {
        state.lastAutoKind = 'statement';
    }
}

function randomChance(probability) {
    return Math.random() < probability;
}

function endsWithQuestion(text) {
    return typeof text === 'string' && /\?\s*$/.test(text);
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
        recordAutoText(state, text);
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
    const styles = [
        'make a sharp comparison between the two games (mechanics, pacing, vibe)',
        'offer a bold, friendly prediction about the first session in the new game',
        'share a concise, surprising fact about the new game (no trivia tone)',
        'ask an open-ended question that invites a story or opinion'
    ];
    const style = choose(styles);
    const baseConstraints = `One sentence. ≤28 words. Relaxed, confident, witty. No trivia phrasing ("did you know"/"fun fact"). No emojis. Don’t repeat: "${state.lastQuestion}" or cliches like "OMG, PS2 nostalgia!". Do not attribute quotes to specific users.`;
    const requireQuestion = state.lastAutoKind === 'statement' || randomChance(0.6);
    let prompt = requireQuestion
        ? `Streamer switched from "${prevGame || 'Unknown'}" to "${newGame}". ${baseConstraints} Ask ONE open-ended question that makes a specific connection or invites a story about "${newGame}". Must end with a question mark. Avoid generic questions.`
        : `Streamer switched from "${prevGame || 'Unknown'}" to "${newGame}". ${baseConstraints} ${style}. Make it specific to "${newGame}" and, if relevant, connect it to "${prevGame}". Avoid generic hype or fact-dumps.`;
    // Prefer creative riff first; fall back to grounded if needed
    let text = await generateStandardResponse(contextPrompt, prompt)
        || await generateSearchResponse(contextPrompt, prompt);
    // Constraint guard: if failed question constraint, try alternate once
    if (text && (requireQuestion && !endsWithQuestion(text))) {
        prompt = requireQuestion
            ? `Streamer switched from "${prevGame || 'Unknown'}" to "${newGame}". ${baseConstraints} Ask ONE playful, open question specific to "${newGame}". ≤26 words. Must end with a question mark. No trivia phrasing.`
            : `Streamer switched from "${prevGame || 'Unknown'}" to "${newGame}". ${baseConstraints} Add ONE witty, conversational riff (no facts lecture) about "${newGame}". ≤26 words. No "did you know".`;
        text = await generateStandardResponse(contextPrompt, prompt)
            || await generateSearchResponse(contextPrompt, prompt);
    }
    if (text) {
        await enqueueMessage(`#${channelName}`, text);
        recordAutoText(state, text);
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
    const styles = [
        'introduce a fresh but related angle on the current topic',
        'offer a thought-provoking, non-obvious observation',
        'share a light personal (bot) opinion with a wink',
        'set up a small prompt that encourages storytelling'
    ];
    const style = choose(styles);
    const baseConstraints = `One sentence. ≤25 words. Relaxed, confident, not anxious. No meta about the lull. No emojis. Don’t repeat: "${state.lastQuestion}". Do not attribute to specific users.`;
    // Prefer statement nudge over question to avoid anxious vibe, unless last auto was statement
    const requireQuestion = state.lastAutoKind === 'statement' || randomChance(0.45);
    let prompt = requireQuestion
        ? `Chat is quiet. Based on "${topic}", ${baseConstraints} Ask ONE open-ended question that invites a short story or opinion (not yes/no, not trivia). Must end with a question mark.`
        : `Chat is quiet. Based on "${topic}", ${baseConstraints} ${style}. Make it feel like a natural nudge, not a forced icebreaker. No trivia tone or filler.`;
    let text = await generateStandardResponse(contextPrompt, prompt)
        || await generateSearchResponse(contextPrompt, prompt);
    if (text && (requireQuestion && !endsWithQuestion(text))) {
        prompt = `Chat is quiet. On "${topic}", ${baseConstraints} Ask ONE playful, open question (≤22 words). Must end with a question mark. No trivia phrasing.`;
        text = await generateStandardResponse(contextPrompt, prompt)
            || await generateSearchResponse(contextPrompt, prompt);
    }
    if (text) {
        await enqueueMessage(`#${channelName}`, text);
        recordAutoText(state, text);
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
    const styles = [
        'acknowledge the shift with a witty aside that links old and new',
        'share a concise, relevant piece of context about the new topic (no trivia tone)',
        'offer a playful opinion or hot take on the new topic',
        'ask an open-ended question that builds on what was just said'
    ];
    const style = choose(styles);
    const baseConstraints = `One sentence. ≤28 words. Natural, conversational, and specific. No trivia phrasing. No emojis. Don’t repeat: "${state.lastQuestion}". Do not invent usernames or attribute quotes unless explicitly provided.`;
    const requireQuestion = state.lastAutoKind === 'statement' || randomChance(0.55);
    let prompt = requireQuestion
        ? `Topic shifted. ${baseConstraints} Ask ONE open-ended question that shows you noticed the pivot and, if relevant, connects the new topic to the prior one. Must end with a question mark.`
        : `Topic shifted. ${baseConstraints} ${style}. If possible, connect the new topic to the prior one to show you followed the thread. Avoid generic hype or fact-dumps.`;
    let text = await generateStandardResponse(contextPrompt, prompt)
        || await generateSearchResponse(contextPrompt, prompt);
    if (text && (requireQuestion && !endsWithQuestion(text))) {
        prompt = requireQuestion
            ? `New topic. ${baseConstraints} Ask ONE playful, open question that builds on what was just said. ≤26 words. Must end with a question mark. No trivia phrasing.`
            : `New topic. ${baseConstraints} Add ONE light, witty remark (no facts lecture). ≤26 words. No "did you know".`;
        text = await generateStandardResponse(contextPrompt, prompt)
            || await generateSearchResponse(contextPrompt, prompt);
    }
    if (text) {
        await enqueueMessage(`#${channelName}`, text);
        recordAutoText(state, text);
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

// --- Celebration Handlers (follows, subscriptions, raids) ---
async function maybeSendFollowCelebration(channelName) {
    const cfg = await getChannelAutoChatConfig(channelName);
    if (cfg.mode === 'off' || cfg.categories.celebrations !== true) return;
    const context = getContextManager().getContextForLLM(channelName, 'system', 'event-follow');
    const contextPrompt = buildContextPrompt(context);
    const prompt = `A new follower joined the channel. Write ONE warm, concise celebration message using current stream/game and chat vibe. Do NOT reveal or guess the username. ≤22 words.`;
    const text = await generateStandardResponse(contextPrompt, prompt)
        || await generateSearchResponse(contextPrompt, prompt);
    if (text) {
        await enqueueMessage(`#${channelName}`, text);
        const state = getState(channelName);
        recordAutoText(state, text);
    }
}

async function maybeSendSubscriptionCelebration(channelName) {
    const cfg = await getChannelAutoChatConfig(channelName);
    if (cfg.mode === 'off' || cfg.categories.celebrations !== true) return;
    const context = getContextManager().getContextForLLM(channelName, 'system', 'event-subscription');
    const contextPrompt = buildContextPrompt(context);
    const prompt = `A new subscription just happened. Write ONE short, hype thank-you that references current stream context. Do NOT reveal or guess the subscriber's username. ≤22 words.`;
    const text = await generateStandardResponse(contextPrompt, prompt)
        || await generateSearchResponse(contextPrompt, prompt);
    if (text) {
        await enqueueMessage(`#${channelName}`, text);
        const state = getState(channelName);
        recordAutoText(state, text);
    }
}

async function maybeSendRaidCelebration(channelName, raiderUserName, viewerCount) {
    const cfg = await getChannelAutoChatConfig(channelName);
    if (cfg.mode === 'off' || cfg.categories.celebrations !== true) return;
    const context = getContextManager().getContextForLLM(channelName, 'system', 'event-raid');
    const contextPrompt = buildContextPrompt(context);
    const viewersPhrase = typeof viewerCount === 'number' && viewerCount > 0 ? `${viewerCount} viewers` : 'raiders';
    const safeRaider = raiderUserName || 'the raiding streamer';
    const prompt = `A raid just arrived from ${safeRaider} with ${viewersPhrase}. Write ONE energetic welcome that fits the current game/topic and invites raiders to hang out. ≤24 words.`;
    const text = await generateStandardResponse(contextPrompt, prompt)
        || await generateSearchResponse(contextPrompt, prompt);
    if (text) {
        await enqueueMessage(`#${channelName}`, text);
        const state = getState(channelName);
        recordAutoText(state, text);
    }
}

export async function notifyFollow(channelName) {
    try {
        await maybeSendFollowCelebration(channelName);
    } catch (e) { /* ignore */ }
}

export async function notifySubscription(channelName) {
    try {
        await maybeSendSubscriptionCelebration(channelName);
    } catch (e) { /* ignore */ }
}

export async function notifyRaid(channelName, raiderUserName, viewerCount) {
    try {
        await maybeSendRaidCelebration(channelName, raiderUserName, viewerCount);
    } catch (e) { /* ignore */ }
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

// --- Ad Break notifier ---
export async function notifyAdBreak(channelName, adEvent) {
    try {
        const cfg = await getChannelAutoChatConfig(channelName);
        if (!cfg || cfg.mode === 'off' || cfg.categories?.ads !== true) return;

        const context = getContextManager().getContextForLLM(channelName, 'system', 'event-ad-break');
        if (!context) return;
        const contextPrompt = buildContextPrompt(context);
        const adLength = adEvent?.duration_seconds || adEvent?.duration || 60;
        const gameName = context.streamGame || 'the stream';

        const prompt = `An ad break of ${adLength} seconds is starting while they are playing ${gameName}. Write ONE short, funny and friendly heads-up to chat. ≤28 words. No commands or emojis spam.`;
        const text = await generateStandardResponse(contextPrompt, prompt)
            || await generateSearchResponse(contextPrompt, prompt);
        if (!text) return;

        await enqueueMessage(`#${channelName}`, text);
        const state = getState(channelName);
        recordAutoText(state, text);
    } catch (error) {
        logger.error({ err: error, channelName }, '[AutoChatManager] Error during ad break notification');
    }
}

export async function notifyAdSoon(channelName, secondsUntil) {
    try {
        const cfg = await getChannelAutoChatConfig(channelName);
        if (!cfg || cfg.mode === 'off' || cfg.categories?.ads !== true) return;
        const context = getContextManager().getContextForLLM(channelName, 'system', 'event-ad-soon');
        if (!context) return;
        const contextPrompt = buildContextPrompt(context);
        const gameName = context.streamGame || 'the stream';
        const secs = Math.max(5, Math.round(secondsUntil || 60));
        const prompt = `An ad is scheduled to start in about ${secs} seconds while they are playing ${gameName}. Write ONE friendly, concise pre-alert to chat. ≤22 words. No spam.`;
        const text = await generateStandardResponse(contextPrompt, prompt)
            || await generateSearchResponse(contextPrompt, prompt);
        if (!text) return;
        await enqueueMessage(`#${channelName}`, text);
        const state = getState(channelName);
        recordAutoText(state, text);
    } catch (error) {
        logger.error({ err: error, channelName }, '[AutoChatManager] Error during ad soon notification');
    }
}
