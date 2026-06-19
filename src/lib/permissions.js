// src/lib/permissions.js
// Centralized permission helpers for Twitch chat role checks.
// All role-checking logic lives here to avoid duplicating badge parsing
// across command handlers and message processors.
//
// Tags arrive via two paths with different value types:
//   • EventSub (eventSubToTags.js): flags are boolean (true/false),
//     badge ids vary by tier ('0', '3000', etc.)
//   • IRC (tmi.js legacy): flags are string '0'/'1',
//     badge ids are typically '1'
//
// All checks below accept both forms to stay path-agnostic.

/**
 * Checks if a user has moderator privileges (mod, lead mod, or broadcaster).
 * @param {object} tags - IRC-style message tags (native or converted from EventSub).
 * @param {string} channelName - Channel name (without '#').
 * @returns {boolean} True if the user is a moderator or broadcaster.
 */
export function isPrivilegedUser(tags, channelName) {
    const isMod = tags.mod === '1' || tags.mod === true
        || tags.badges?.moderator === '1'
        || !!tags.badges?.lead_moderator;
    const isBroadcaster = !!tags.badges?.broadcaster || tags.username === channelName;
    return isMod || isBroadcaster;
}

/**
 * Checks whether a user satisfies a required permission level.
 * Permission hierarchy (most → least restrictive):
 *   broadcaster > moderator > vip > subscriber > everyone
 *
 * @param {string} permission - Required permission level.
 * @param {object} tags - IRC-style message tags.
 * @param {string} channelName - Channel name (without '#').
 * @returns {boolean} True if the user meets or exceeds the permission level.
 */
export function hasPermissionLevel(permission, tags, channelName) {
    if (!permission || permission === 'everyone') return true;

    const isBroadcaster = !!tags.badges?.broadcaster || tags.username === channelName;
    const isModerator = tags.mod === '1' || tags.mod === true
        || tags.badges?.moderator === '1'
        || !!tags.badges?.lead_moderator;
    const isVip = tags.vip === '1' || tags.vip === true || !!tags.badges?.vip;
    const isSubscriber = tags.subscriber === '1' || tags.subscriber === true
        || !!tags.badges?.subscriber;

    switch (permission) {
        case 'broadcaster': return isBroadcaster;
        case 'moderator': return isModerator || isBroadcaster;
        case 'vip': return isVip || isModerator || isBroadcaster;
        case 'subscriber': return isSubscriber || isVip || isModerator || isBroadcaster;
        default: return true;
    }
}
