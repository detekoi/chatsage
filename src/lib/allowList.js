// src/lib/allowList.js
// In-memory cache populated from Firestore managedChannels collection.
// Firestore is the single source of truth for which channels are allowed.
//
// Two separate questions are answered here, and they are deliberately not the
// same one:
//
//   isChannelAllowed() — is this channel approved to use the service at all?
//     True for every managedChannels document, active or not. Approval is
//     granted by the document existing (the web UI refuses to activate a
//     channel whose document an admin has not created first).
//
//   isChannelActive()  — is the bot currently switched on for this channel?
//     True only while isActive is set on the document.
//
// Deactivating the bot from the dashboard clears isActive but keeps the
// document, so a channel that stops using the bot stays approved and can be
// switched back on without re-approval. Gate anything that acts in a channel
// (webhooks, chat handling) on isChannelActive; gate anything that merely
// belongs to the channel owner on isChannelAllowed.

// Approved channels, indexed by broadcaster ID where one is known and by login
// name always — legacy documents predate twitchUserId and carry only a name.
const allowedBroadcasterIds = new Set();
const allowedChannelNames = new Set();

// The subset of the above whose bot is currently switched on.
const activeBroadcasterIds = new Set();
const activeChannelNames = new Set();

// Channel login name (lowercase) → Twitch User ID mapping for transparent lookups
const channelNameToIdMap = new Map();

// Twitch User ID → Channel login name (lowercase) reverse mapping
const channelIdToNameMap = new Map();

/**
 * Both forms of an identifier are indexed directly, so a lookup needs no
 * name → ID resolution step: register() adds a channel's login name to the name
 * set whenever it adds its ID to the ID set, and every removal path takes both
 * out together.
 */
function matches(identifier, ids, names) {
    const normalized = String(identifier).trim();

    // Direct match against broadcaster IDs
    if (ids.has(normalized)) return true;

    return names.has(normalized.toLowerCase());
}

/**
 * Returns true if the broadcaster is approved to use the bot, whether or not
 * the bot is currently switched on for them.
 * Accepts either a Twitch User ID (numeric string) or a channel login name.
 *
 * Fails closed: an empty allowed set denies everything. There is deliberately
 * no "startup grace period" that allows all channels before Firestore has
 * loaded — that fallback let webhooks for unauthorized channels through during
 * cold starts. Cold-start sequencing is handled by waitForInit() in eventsub.js
 * instead, so this function must never be relaxed to compensate for it.
 *
 * The allowed set is populated from Firestore managedChannels by channelManager.
 */
export function isChannelAllowed(identifier) {
    if (!identifier) return false;
    return matches(identifier, allowedBroadcasterIds, allowedChannelNames);
}

/**
 * Returns true if the bot is currently switched on for this broadcaster
 * (managedChannels.isActive). Accepts either a Twitch User ID or a login name.
 *
 * Fails closed for the same reason isChannelAllowed does.
 */
export function isChannelActive(identifier) {
    if (!identifier) return false;
    return matches(identifier, activeBroadcasterIds, activeChannelNames);
}

/**
 * Drop a login name this broadcaster ID no longer goes by. A rename arrives as
 * a modified document carrying the same ID and a new channelName; without this
 * the old name would stay allowed and active for the life of the process, and
 * whoever claims the freed handle next would inherit that access.
 */
function forgetPreviousName(id, currentName) {
    const previousName = channelIdToNameMap.get(id);
    if (!previousName || previousName === currentName) return;

    allowedChannelNames.delete(previousName);
    activeChannelNames.delete(previousName);
    channelNameToIdMap.delete(previousName);
}

function register({ name, twitchUserId, isActive }) {
    // Callers that predate the approved/active split only ever passed active
    // channels, so an absent flag means active.
    const active = isActive !== false;
    const id = twitchUserId ? String(twitchUserId) : null;
    const lower = name ? String(name).trim().toLowerCase() : null;

    if (!id && !lower) return;

    if (id) {
        allowedBroadcasterIds.add(id);
        if (active) activeBroadcasterIds.add(id);
    }
    if (lower) {
        allowedChannelNames.add(lower);
        if (active) activeChannelNames.add(lower);
    }
    if (id && lower) {
        forgetPreviousName(id, lower);
        channelNameToIdMap.set(lower, id);
        channelIdToNameMap.set(id, lower);
    }
}

/**
 * Bulk-update the caches from Firestore managedChannels data. Pass every
 * document, inactive ones included — they stay approved.
 * Called by channelManager after loading managed channels.
 * @param {Array<{name: string, twitchUserId: string|null, isActive?: boolean}>} channels
 */
export function updateAllowedChannels(channels) {
    allowedBroadcasterIds.clear();
    allowedChannelNames.clear();
    activeBroadcasterIds.clear();
    activeChannelNames.clear();
    channelNameToIdMap.clear();
    channelIdToNameMap.clear();
    for (const ch of channels) {
        register(ch);
    }
}

/**
 * Register a single channel as approved, without changing whether its bot is
 * switched on. Used by channelManager's real-time listener.
 */
export function addAllowedChannel(channelName, twitchUserId) {
    register({ name: channelName, twitchUserId, isActive: false });
}

/**
 * Switch a channel's bot on or off in the cache, approving it on the way if it
 * is not known yet. Approval is untouched when switching off — a deactivated
 * channel remains on the allow-list.
 */
export function setChannelActive(channelName, twitchUserId, active) {
    register({ name: channelName, twitchUserId, isActive: !!active });
    if (active) return;

    const id = twitchUserId ? String(twitchUserId) : null;
    const lower = channelName ? String(channelName).trim().toLowerCase() : null;

    if (id) activeBroadcasterIds.delete(id);
    if (lower) activeChannelNames.delete(lower);
}

/**
 * Remove a channel from every cache. This revokes approval, so it is only for
 * a managedChannels document that has actually been deleted — deactivating the
 * bot calls setChannelActive instead.
 *
 * Either identifier alone is enough: each is used to recover the other, so a
 * caller that knows only the name cannot leave the ID behind, or vice versa.
 */
export function removeAllowedChannel(channelName, twitchUserId) {
    const names = new Set();
    const ids = new Set();

    if (twitchUserId) {
        ids.add(String(twitchUserId));
    }
    if (channelName) {
        names.add(String(channelName).trim().toLowerCase());
    }
    for (const id of ids) {
        const mappedName = channelIdToNameMap.get(id);
        if (mappedName) names.add(mappedName);
    }
    for (const name of names) {
        const mappedId = channelNameToIdMap.get(name);
        if (mappedId) ids.add(mappedId);
    }

    for (const id of ids) {
        allowedBroadcasterIds.delete(id);
        activeBroadcasterIds.delete(id);
        channelIdToNameMap.delete(id);
    }
    for (const name of names) {
        allowedChannelNames.delete(name);
        activeChannelNames.delete(name);
        channelNameToIdMap.delete(name);
    }
}

/**
 * Resolves a channel login name to its Twitch broadcaster ID.
 *
 * Config keyed by broadcaster ID (channelPersonas) has to be reachable from the
 * hot path, which only ever has channel names — IRC gives names, not IDs. The
 * mapping is already maintained here from managedChannels and refreshed by its
 * onSnapshot listener, so this stays a synchronous in-memory lookup.
 *
 * @param {string} channelName - Channel login name, with or without '#'.
 * @returns {string|null} Broadcaster ID, or null for a channel whose document
 *   predates twitchUserId or is not yet loaded.
 */
export function getBroadcasterIdForChannel(channelName) {
    if (!channelName) return null;
    const lower = String(channelName).trim().toLowerCase().replace(/^#/, '');
    return channelNameToIdMap.get(lower) || null;
}

/**
 * Reverse of getBroadcasterIdForChannel.
 * @param {string} twitchUserId
 * @returns {string|null} Lowercase channel login name, or null if unknown.
 */
export function getChannelNameForBroadcasterId(twitchUserId) {
    if (!twitchUserId) return null;
    return channelIdToNameMap.get(String(twitchUserId)) || null;
}
