// src/lib/channelKey.js
//
// Firestore document keys for channel-scoped data.
//
// Every per-channel collection (memories, quotes, timers, custom commands,
// command settings, auto-chat, language, game configs, personas) is keyed by
// the broadcaster's Twitch user ID. Login names are mutable: Twitch lets a
// user rename, and eventually releases the old name for someone else to
// register. A name-keyed document therefore orphans on rename and can be
// inherited by whoever claims the freed name next — for data that gets
// composed into prompts, that is a cross-channel leak.
//
// The runtime only ever has login names (IRC gives names, not IDs), so the
// mapping is resolved here from the allow-list cache that channelManager
// keeps in sync with managedChannels. Resolution failing is a configuration
// error and is reported as such rather than silently falling back to the
// name, which would fork a channel's data across two documents.

import { getBroadcasterIdForChannel, getChannelNameForBroadcasterId } from './allowList.js';

export class UnresolvedChannelError extends Error {
    /**
     * @param {string} channelName
     */
    constructor(channelName) {
        super(`No broadcaster ID is known for channel "${channelName}"; is it in managedChannels with a twitchUserId?`);
        this.name = 'UnresolvedChannelError';
        this.channelName = channelName;
    }
}

/**
 * Normalizes a channel login for lookups: lowercase, no leading '#'.
 * @param {string} channelName
 * @returns {string}
 */
export function normalizeChannelName(channelName) {
    return String(channelName || '').trim().toLowerCase().replace(/^#/, '');
}

/**
 * Whether a document ID is a broadcaster ID rather than a legacy login key.
 * Twitch user IDs are numeric; logins must start with a letter or underscore.
 * @param {string} docId
 * @returns {boolean}
 */
export function isBroadcasterIdKey(docId) {
    return /^\d+$/.test(String(docId || ''));
}

/**
 * The Firestore document key for a channel's data: its broadcaster ID.
 * @param {string} channelName - Channel login, with or without '#'.
 * @returns {string}
 * @throws {UnresolvedChannelError} When the channel has no known broadcaster ID.
 */
export function channelDocKey(channelName) {
    const login = normalizeChannelName(channelName);
    const id = getBroadcasterIdForChannel(login);
    if (!id) throw new UnresolvedChannelError(login);
    return id;
}

/**
 * Reverse of channelDocKey, for loaders that walk a whole collection and need
 * to hand each document back to code that works in login names.
 *
 * The allow-list mapping is authoritative because it follows renames; the
 * document's own `channelName` field is only what the login was at the last
 * write. A document whose ID resolves to nothing (channel since removed from
 * managedChannels) still falls back to that field, so the caller can decide
 * what to do with it rather than losing it.
 *
 * A legacy login-keyed document is never resolved, even though it carries a
 * `channelName`: until the migration deletes it, it sits beside the ID-keyed
 * copy, and Firestore lists it after (logins sort after digits), so it would
 * otherwise overwrite the migrated data in every loader's map.
 *
 * @param {string} docId - The document ID (a broadcaster ID).
 * @param {{channelName?: string}|null|undefined} [data] - The document's data, if loaded.
 * @returns {string|null} Lowercase login, or null if nothing identifies the channel.
 */
export function channelNameForDocKey(docId, data) {
    if (!isBroadcasterIdKey(docId)) return null;
    const mapped = getChannelNameForBroadcasterId(docId);
    if (mapped) return mapped;
    const stored = data && typeof data.channelName === 'string' ? normalizeChannelName(data.channelName) : '';
    return stored || null;
}
