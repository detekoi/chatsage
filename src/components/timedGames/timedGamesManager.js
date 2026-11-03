// src/components/timedGames/timedGamesManager.js
// Starts chat games on a timer. When a channel turns timed games on, the bot
// starts one round of the next game in the channel's pool every
// `intervalMinutes` while the stream is live, rotating trivia -> geo -> riddle
// through whichever of those the channel picked. Off by default.

import logger from '../../lib/logger.js';
import config from '../../config/index.js';
import { sendLocalized } from '../../lib/localizedMessage.js';
import { isStreamLive } from '../context/liveStatus.js';
import { isCommandDisabled } from '../context/commandStateManager.js';
import { ownsChannel, onOwnershipChange } from '../../lib/channelOwnership.js';
import { getTriviaGameManager, activeGames as triviaGames } from '../trivia/triviaGameManager.js';
import { getGeoGameManager, activeGames as geoGames } from '../geo/geoGameManager.js';
import { getRiddleGameManager, activeGames as riddleGames } from '../riddle/riddleGameManager.js';
import {
    loadAllTimedGamesConfigs,
    listenForTimedGamesChanges,
    claimTimedGameRun,
    recordTimedGameRun,
    TIMED_GAME_IDS,
} from './timedGamesStorage.js';

const TICK_MS = 60 * 1000;
// Offset the first tick so it falls between the auto-chat and timer ticks.
const START_DELAY_MS = 40 * 1000;

let startTimeoutId = null;
let intervalId = null;
let unsubscribeListener = null;
let unsubscribeOwnership = null;
let tickInProgress = false;

// Settings, written only by the initial load and the snapshot listener.
const configCache = new Map(); // channelName -> { enabled, intervalMinutes, games, lastRunAtMs, lastGame }

// Firing state, written only by the tick. Kept apart from configCache so the
// bot's own lastRunAt writes echoing back through the listener never rewind it.
const runtime = new Map(); // channelName -> { lastRunAtMs, lastGame }

const INTRO_MESSAGES = {
    trivia: { key: 'timedGames.StartingTrivia', text: '⏰ Timed game! Trivia starts now. Type your answer in chat!' },
    geo: { key: 'timedGames.StartingGeo', text: '⏰ Timed game! Geo-Game starts now. Guess the location in chat!' },
    riddle: { key: 'timedGames.StartingRiddle', text: '⏰ Timed game! A riddle starts now. Type your guess in chat!' },
};

function seedRuntime(channelName, cfg) {
    runtime.set(channelName, {
        lastRunAtMs: cfg?.lastRunAtMs || 0,
        lastGame: cfg?.lastGame || null,
    });
}

function handleConfigChange({ type, channelName, config: cfg }) {
    if (type === 'removed' || !cfg) {
        configCache.delete(channelName);
        runtime.delete(channelName);
        return;
    }
    configCache.set(channelName, cfg);
    if (!runtime.has(channelName)) seedRuntime(channelName, cfg);
    logger.debug(`[TimedGames] Config ${type} for ${channelName}`);
}

/**
 * A channel just moved to this instance. The previous owner kept writing
 * lastRunAt and lastGame, so rebuild runtime from the listener-fresh config to
 * continue its schedule and rotation instead of starting a game straight away.
 */
function handleChannelAcquired({ type, channelName }) {
    if (type !== 'acquired' || !channelName) return;
    const cfg = configCache.get(channelName);
    runtime.delete(channelName);
    if (cfg) seedRuntime(channelName, cfg);
}

/**
 * @returns {boolean} True when any chat game is running (or wrapping up) in the channel.
 */
export function isAnyGameActive(channelName) {
    return [triviaGames, geoGames, riddleGames].some(games => {
        const state = games.get(channelName)?.state;
        return state !== undefined && state !== 'idle';
    });
}

/**
 * Picks the next game after `lastGame` in canonical order, limited to the
 * channel's pool and skipping games whose command is disabled in the channel.
 * @returns {string|null} The game, or null when every game in the pool is disabled.
 */
export function pickNextGame(channelName, pool, lastGame) {
    const ordered = TIMED_GAME_IDS.filter(id => pool.includes(id));
    if (ordered.length === 0) return null;
    const lastPos = TIMED_GAME_IDS.indexOf(lastGame);
    let start = ordered.findIndex(id => TIMED_GAME_IDS.indexOf(id) > lastPos);
    if (start === -1) start = 0;
    for (let i = 0; i < ordered.length; i++) {
        const game = ordered[(start + i) % ordered.length];
        if (!isCommandDisabled(channelName, game)) return game;
    }
    return null;
}

function botLogin() {
    return String(config.twitch?.username || '').toLowerCase() || null;
}

/**
 * Starts one round of `game`. The bot is the initiator, so mods can end it
 * with the game's own stop command.
 * @returns {Promise<{success: boolean}>}
 */
async function startGame(channelName, game) {
    const initiator = botLogin();
    const channel = `#${channelName}`;
    const intro = INTRO_MESSAGES[game];

    // Pick a preferred topic or title first. A game started with one posts its
    // own start announcement, so the timed intro is only for games without.
    let start;
    let announcesItself = false;
    if (game === 'geo') {
        const geo = getGeoGameManager();
        const title = await geo.pickPreferredGameTitle(channelName);
        announcesItself = !!title;
        start = title
            ? () => geo.startGame(channelName, 'game', title, initiator, 1)
            : () => geo.startGame(channelName, 'real', null, initiator, 1);
    } else if (game === 'trivia') {
        const trivia = getTriviaGameManager();
        const topic = await trivia.pickPreferredTopic(channelName);
        announcesItself = !!topic;
        start = () => trivia.startGame(channelName, topic, initiator, 1);
    } else {
        start = () => getRiddleGameManager().startGame(channelName, null, initiator, 1);
    }

    // Each game manager only refuses to start over its own game, so check all
    // three again after the claim and the preference lookup: a viewer may have
    // started a different game in the meantime.
    if (isAnyGameActive(channelName)) {
        return { success: false, error: 'Another game started first' };
    }

    if (!announcesItself) await sendLocalized(channel, intro.key, {}, intro.text);
    return start();
}

async function runForChannel(channelName, cfg, nowMs) {
    const state = runtime.get(channelName);
    if (!state) return;
    const intervalMs = cfg.intervalMinutes * 60 * 1000;
    if (nowMs - state.lastRunAtMs < intervalMs) return;
    // A game already running (started by chat or the last timed run) delays
    // this one to a later tick rather than skipping the run.
    if (isAnyGameActive(channelName)) return;

    const game = pickNextGame(channelName, cfg.games, state.lastGame);
    if (!game) {
        logger.debug(`[TimedGames] Every game in ${channelName}'s pool is disabled, skipping`);
        return;
    }

    // Advance runtime before any slow work so a slow or failed start cannot
    // re-fire on the next tick. A failed start still moves the rotation on, so
    // one broken game cannot block the others.
    state.lastRunAtMs = nowMs;
    state.lastGame = game;

    let claimed = false;
    try {
        const claim = await claimTimedGameRun(channelName, intervalMs, game);
        if (!claim.claimed) {
            state.lastRunAtMs = claim.lastRunAtMs || nowMs;
            state.lastGame = claim.lastGame;
            logger.info({ channel: channelName }, '[TimedGames] Run already claimed elsewhere, skipping');
            return;
        }
        claimed = true;
    } catch (err) {
        // Fail open, as timers do: with a single owner per channel a duplicate is unlikely.
        logger.warn({ err, channel: channelName }, '[TimedGames] Could not claim run, starting anyway');
    }

    // The stream or the setting may have changed while the claim was in flight.
    // startGame() checks again for a game that started in the meantime.
    if (!isStreamLive(channelName) || configCache.get(channelName)?.enabled !== true) return;

    try {
        const result = await startGame(channelName, game);
        if (result?.success) {
            logger.info(`[TimedGames] Started ${game} in ${channelName}`);
        } else {
            logger.warn({ channel: channelName, game, error: result?.error },
                '[TimedGames] Game did not start');
        }
    } catch (err) {
        logger.error({ err, channel: channelName, game }, '[TimedGames] Error starting game');
    }
    if (!claimed) recordTimedGameRun(channelName, game);
}

async function tick() {
    if (tickInProgress) {
        logger.debug('[TimedGames] Tick skipped, previous tick still running');
        return;
    }
    tickInProgress = true;
    try {
        const nowMs = Date.now();
        const runs = [];
        for (const [channelName, cfg] of configCache) {
            if (!cfg.enabled) continue;
            // Another instance runs timed games for channels it owns.
            if (!ownsChannel(channelName)) continue;
            if (!isStreamLive(channelName)) continue;
            runs.push(runForChannel(channelName, cfg, nowMs).catch(err => {
                logger.error({ err, channel: channelName }, '[TimedGames] Error processing channel during tick');
            }));
        }
        // Channels start their games in parallel, so one slow question
        // generation does not hold back the rest.
        await Promise.all(runs);
    } finally {
        tickInProgress = false;
    }
}

export async function startTimedGamesManager() {
    if (intervalId || startTimeoutId) {
        logger.warn('[TimedGames] Already running');
        return;
    }
    logger.info('[TimedGames] Starting...');

    const all = await loadAllTimedGamesConfigs();
    for (const [channelName, cfg] of all) {
        configCache.set(channelName, cfg);
        seedRuntime(channelName, cfg);
    }

    unsubscribeListener = listenForTimedGamesChanges(handleConfigChange);
    unsubscribeOwnership = onOwnershipChange(handleChannelAcquired);

    startTimeoutId = setTimeout(() => {
        startTimeoutId = null;
        tick();
        intervalId = setInterval(tick, TICK_MS);
    }, START_DELAY_MS);

    logger.info(`[TimedGames] Started with configs for ${configCache.size} channels`);
}

export function stopTimedGamesManager() {
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
    if (unsubscribeOwnership) {
        unsubscribeOwnership();
        unsubscribeOwnership = null;
    }
    configCache.clear();
    runtime.clear();
    logger.info('[TimedGames] Stopped');
}

// Exported for testing only
export {
    tick as _tick,
    runForChannel as _runForChannel,
    handleConfigChange as _handleConfigChange,
    handleChannelAcquired as _handleChannelAcquired,
};
export function _getRuntime() { return runtime; }
export function _getConfigCache() { return configCache; }
