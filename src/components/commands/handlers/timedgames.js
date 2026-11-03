// src/components/commands/handlers/timedgames.js
// !timedgames: mod-only settings for chat games the bot starts on a timer.
//
//   !timedgames                       -> status
//   !timedgames on | off              -> turn timed games on or off
//   !timedgames interval <minutes>    -> how often a game starts
//   !timedgames games trivia,riddle   -> which games the bot rotates through

import {
    getTimedGamesConfig,
    saveTimedGamesConfig,
    parseGameList,
    TIMED_GAME_IDS,
    MIN_INTERVAL_MINUTES,
    MAX_INTERVAL_MINUTES,
} from '../../timedGames/timedGamesStorage.js';
import { pickNextGame } from '../../timedGames/timedGamesManager.js';
import { sendLocalized } from '../../../lib/localizedMessage.js';

const HELP_TEXT = 'Usage: !timedgames [on|off] | !timedgames interval <minutes> | !timedgames games trivia,geo,riddle';

const ON_WORDS = new Set(['on', 'enable', 'start']);
const OFF_WORDS = new Set(['off', 'disable', 'stop']);

function formatGames(games) {
    return games.join(', ');
}

async function sendStatus(channel, channelName, replyToId) {
    const cfg = await getTimedGamesConfig(channelName);
    const games = formatGames(cfg.games);
    const minutes = cfg.intervalMinutes;
    if (!cfg.enabled) {
        return sendLocalized(channel, 'cmd.timedgames.StatusOff', { minutes, games },
            `Timed games are off. When on, the bot starts a game every ${minutes} min from: ${games}. Turn them on with !timedgames on`,
            { replyToId });
    }
    const next = pickNextGame(channelName, cfg.games, cfg.lastGame) || games;
    return sendLocalized(channel, 'cmd.timedgames.StatusOn', { minutes, games, next },
        `Timed games are on: a game every ${minutes} min while live, from: ${games}. Next up: ${next}`,
        { replyToId });
}

async function save(channel, channelName, partial, replyToId) {
    const ok = await saveTimedGamesConfig(channelName, partial);
    if (!ok) {
        await sendLocalized(channel, 'cmd.timedgames.SaveFailed', {},
            'Could not save the timed games settings. Please try again.', { replyToId });
    }
    return ok;
}

async function execute({ channel, user, args }) {
    const channelName = channel.substring(1);
    const replyToId = user?.id || user?.['message-id'] || null;
    const sub = (args[0] || '').toLowerCase();

    if (!sub || sub === 'status') {
        return sendStatus(channel, channelName, replyToId);
    }

    if (ON_WORDS.has(sub)) {
        const cfg = await getTimedGamesConfig(channelName);
        if (!await save(channel, channelName, { enabled: true }, replyToId)) return;
        const minutes = cfg.intervalMinutes;
        const games = formatGames(cfg.games);
        return sendLocalized(channel, 'cmd.timedgames.TurnedOn', { minutes, games },
            `Timed games are on. The bot starts a game every ${minutes} min while the stream is live, from: ${games}.`,
            { replyToId });
    }

    if (OFF_WORDS.has(sub)) {
        if (!await save(channel, channelName, { enabled: false }, replyToId)) return;
        return sendLocalized(channel, 'cmd.timedgames.TurnedOff', {},
            'Timed games are off. Games now start only from chat commands.', { replyToId });
    }

    if (sub === 'interval') {
        const raw = args[1];
        const minutes = Number(raw);
        if (!/^\d+$/.test(raw || '') || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
            return sendLocalized(channel, 'cmd.timedgames.IntervalInvalid',
                { min: MIN_INTERVAL_MINUTES, max: MAX_INTERVAL_MINUTES },
                `Give the interval in whole minutes, from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES}. Example: !timedgames interval 30`,
                { replyToId });
        }
        if (!await save(channel, channelName, { intervalMinutes: minutes }, replyToId)) return;
        return sendLocalized(channel, 'cmd.timedgames.IntervalSet', { minutes },
            `Timed games now start every ${minutes} min.`, { replyToId });
    }

    if (sub === 'games') {
        const tokens = args.slice(1).join(' ').split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
        const games = parseGameList(tokens);
        const allKnown = tokens.every(tok => TIMED_GAME_IDS.includes(tok));
        if (games.length === 0 || !allKnown) {
            const options = formatGames(TIMED_GAME_IDS);
            return sendLocalized(channel, 'cmd.timedgames.GamesInvalid', { options },
                `Name one or more of these games: ${options}. Example: !timedgames games trivia,riddle`,
                { replyToId });
        }
        if (!await save(channel, channelName, { games }, replyToId)) return;
        const list = formatGames(games);
        return sendLocalized(channel, 'cmd.timedgames.GamesSet', { games: list },
            `Timed games now rotate through: ${list}.`, { replyToId });
    }

    return sendLocalized(channel, 'usage.timedgames.Help', {}, HELP_TEXT, { replyToId });
}

export default {
    execute,
    permission: 'moderator',
    description: 'Start chat games (trivia, geo, riddle) on a timer while the stream is live. Off by default.',
    usage: '!timedgames [on|off] | !timedgames interval <minutes> | !timedgames games <trivia,geo,riddle>',
};
