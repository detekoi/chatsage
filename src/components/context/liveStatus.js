// src/components/context/liveStatus.js
// Shared stream checks used by auto-chat, timers and the chat games.

import { getContextManager } from './contextManager.js';

/**
 * Whether a channel's stream is currently live, based on the context
 * manager's stream state (a real game set and not the 'N/A' placeholder).
 * @param {string} channelName - Channel name (without #).
 * @returns {boolean}
 */
export function isStreamLive(channelName) {
    const ctx = getContextManager().getContextForLLM(channelName, 'system', 'live-check');
    return !!(ctx && ctx.streamGame && ctx.streamGame !== 'N/A');
}

/**
 * The game a channel is streaming, from the same stream state that
 * isStreamLive reads.
 * @param {string} channelName - Channel name (without #).
 * @returns {string|null} The game name, or null when no game is known.
 */
export function getStreamGame(channelName) {
    try {
        const ctx = getContextManager().getContextForLLM(channelName, 'system', 'stream-game');
        return ctx && ctx.streamGame && ctx.streamGame !== 'N/A' ? ctx.streamGame : null;
    } catch {
        return null;
    }
}
