// src/components/context/liveStatus.js
// Shared live-stream check used by auto-chat and timer gating.

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
