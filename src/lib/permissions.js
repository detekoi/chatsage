// Centralized Twitch role checks — single source of truth.
// Accepts both EventSub (boolean flags, variable badge ids) and IRC (string '0'/'1') tag formats.
import logger from './logger.js';

// Shared role computation used by both exported functions.
function _resolveRoles(tags, channelName) {
    const isMod = tags.mod === '1' || tags.mod === true
        || !!tags.badges?.moderator
        || !!tags.badges?.lead_moderator;
    const isBroadcaster = !!tags.badges?.broadcaster || tags.username === channelName;
    const isVip = tags.vip === '1' || tags.vip === true || !!tags.badges?.vip;
    const isSub = tags.subscriber === '1' || tags.subscriber === true || !!tags.badges?.subscriber;
    return { isMod, isBroadcaster, isVip, isSub };
}

// Returns true if the user is a moderator (including lead mod) or the broadcaster.
export function isPrivilegedUser(tags, channelName) {
    const { isMod, isBroadcaster } = _resolveRoles(tags, channelName);
    return isMod || isBroadcaster;
}

// Checks whether a user meets a required permission level.
// Hierarchy: broadcaster > moderator > vip > subscriber > everyone.
// Unrecognized levels are denied and logged as a warning.
export function hasPermissionLevel(permission, tags, channelName) {
    if (!permission || permission === 'everyone') return true;

    const { isMod, isBroadcaster, isVip, isSub } = _resolveRoles(tags, channelName);

    switch (permission) {
        case 'broadcaster': return isBroadcaster;
        case 'moderator': return isMod || isBroadcaster;
        case 'vip': return isVip || isMod || isBroadcaster;
        case 'subscriber': return isSub || isVip || isMod || isBroadcaster;
        default:
            logger.warn({ permission, user: tags.username }, 'Unrecognized permission level — denying access');
            return false;
    }
}
