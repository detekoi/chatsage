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

function matches(identifier, ids, names) {
  const normalized = String(identifier).trim();

  // Direct match against broadcaster IDs
  if (ids.has(normalized)) return true;

  const lower = normalized.toLowerCase();
  if (names.has(lower)) return true;

  // Fallback: resolve login name to broadcaster ID via cache
  const mappedId = channelNameToIdMap.get(lower);
  return Boolean(mappedId && ids.has(mappedId));
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
 * Switch a channel's bot on or off in the cache. Approval is untouched either
 * way — a deactivated channel remains on the allow-list.
 */
export function setChannelActive(channelName, twitchUserId, active) {
  register({ name: channelName, twitchUserId, isActive: false });

  const id = twitchUserId ? String(twitchUserId) : null;
  const lower = channelName ? String(channelName).trim().toLowerCase() : null;

  if (active) {
    if (id) activeBroadcasterIds.add(id);
    if (lower) activeChannelNames.add(lower);
  } else {
    if (id) activeBroadcasterIds.delete(id);
    if (lower) activeChannelNames.delete(lower);
  }
}

/**
 * Remove a channel from every cache. This revokes approval, so it is only for
 * a managedChannels document that has actually been deleted — deactivating the
 * bot calls setChannelActive instead.
 */
export function removeAllowedChannel(channelName, twitchUserId) {
  if (twitchUserId) {
    const id = String(twitchUserId);
    allowedBroadcasterIds.delete(id);
    activeBroadcasterIds.delete(id);
    const mappedName = channelIdToNameMap.get(id);
    if (mappedName) {
      allowedChannelNames.delete(mappedName);
      activeChannelNames.delete(mappedName);
      channelNameToIdMap.delete(mappedName);
    }
    channelIdToNameMap.delete(id);
  }
  if (channelName) {
    const lower = String(channelName).trim().toLowerCase();
    allowedChannelNames.delete(lower);
    activeChannelNames.delete(lower);
    channelNameToIdMap.delete(lower);
  }
}
