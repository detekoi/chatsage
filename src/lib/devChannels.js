// src/lib/devChannels.js
// Shared dev-channel identification logic.
//
// In development, TWITCH_CHANNELS env var lists channels that should be allowed
// even when they are isActive:false in Firestore (intentional, to prevent the
// production bot from subscribing to test channels).
//
// This module computes the normalised set ONCE at import time — config.twitch.channels
// is loaded from env at process start and never mutated (src/config/loader.js:65-67).

import config from '../config/index.js';

/** @type {ReadonlySet<string>} Lowercase channel login names from TWITCH_CHANNELS */
const DEV_CHANNEL_SET = new Set(
    config.app.nodeEnv === 'development'
        ? config.twitch.channels.map(c => String(c).trim().toLowerCase()).filter(Boolean)
        : []
);

/**
 * Returns true if `login` is a dev-mode channel configured via TWITCH_CHANNELS.
 * Always returns false outside NODE_ENV=development.
 *
 * @param {string} login - Channel login name (case-insensitive)
 * @returns {boolean}
 */
export function isDevChannel(login) {
    if (!login || DEV_CHANNEL_SET.size === 0) return false;
    return DEV_CHANNEL_SET.has(login.toLowerCase());
}

/**
 * Returns true if any dev channels are configured (NODE_ENV=development
 * and TWITCH_CHANNELS is non-empty).
 * @returns {boolean}
 */
export function hasDevChannels() {
    return DEV_CHANNEL_SET.size > 0;
}
