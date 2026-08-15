// src/components/twitch/channelManager.js
import { getFirestore } from '../../lib/firestore.js';
import logger from '../../lib/logger.js';
import { updateAllowedChannels, addAllowedChannel, setChannelActive, removeAllowedChannel, isChannelAllowed as _isAllowed, isChannelActive as _isActive } from '../../lib/allowList.js';
import { isDevChannel } from '../../lib/devChannels.js';

// Collection name (must match the name used in chatsage-web-ui)
const MANAGED_CHANNELS_COLLECTION = 'managedChannels';

/**
 * Custom error class for channel management operations.
 */
export class ChannelManagerError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'ChannelManagerError';
        this.cause = cause;
    }
}

/**
 * No-op – Firestore is now initialized centrally via initializeFirestore() in initComponents.js.
 */
export async function initializeChannelManager() {
    logger.debug('[ChannelManager] Using shared Firestore client.');
}

// getChannelManager function removed - use getFirestoreDb() instead

/** @returns {import('@google-cloud/firestore').Firestore} */
function _getDb() {
    return getFirestore();
}

// Login names that were active as of the most recent full Firestore fetch, i.e.
// the set EventSub was subscribed for at startup. Null until the first fetch.
let lastFetchedActiveNames = null;

/**
 * Retrieves all active managed channels from Firestore, and refreshes the
 * allow-list cache from the whole collection along the way.
 *
 * The read is deliberately unfiltered: approval to use the service is the
 * document existing, not isActive, so a channel that has switched the bot off
 * still belongs on the allow-list. Only the returned list — the channels the
 * bot actually runs in — is narrowed to the active ones.
 *
 * @returns {Promise<Array<{name: string, twitchUserId: string|null}>>} Array of active channel objects.
 */
export async function getActiveManagedChannels() {
    const dbInstance = _getDb();
    logger.info("[ChannelManager] Fetching managed channels from Firestore...");

    try {
        const snapshot = await dbInstance.collection(MANAGED_CHANNELS_COLLECTION).get();

        const channels = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data && typeof data.channelName === 'string') {
                channels.push({
                    name: data.channelName.toLowerCase(),
                    twitchUserId: data.twitchUserId || null,
                    isActive: !!data.isActive
                });
            } else {
                logger.warn({ docId: doc.id }, `[ChannelManager] Document in managedChannels missing valid 'channelName'. Skipping.`);
            }
        });

        // Populate the allow-list cache from Firestore (the single source of truth)
        updateAllowedChannels(channels);

        const activeChannels = channels.filter(ch => ch.isActive);
        const channelNames = activeChannels.map(ch => ch.name);

        // Baseline for the listener's initial snapshot: these are the channels
        // startup subscribes to, so anything that differs by the time the
        // listener attaches was changed in between and still needs syncing.
        lastFetchedActiveNames = new Set(channelNames);

        logger.info(`[ChannelManager] Successfully fetched ${channelNames.length} active managed channels (${channels.length} approved).`);
        logger.debug(`[ChannelManager] Active channels: ${channelNames.join(', ')}`);

        return activeChannels;
    } catch (error) {
        logger.error({ err: error }, "[ChannelManager] Error fetching active managed channels.");
        throw new ChannelManagerError("Failed to fetch active managed channels.", error);
    }
}

/**
 * Checks whether a given channel is approved to use the service according to
 * the in-memory cache populated from Firestore managedChannels. Approved is not
 * the same as switched on — a channel that deactivated the bot stays approved.
 * Accepts either a Twitch User ID or a channel login name.
 * @param {string} identifier - The Twitch User ID or channel name.
 * @returns {Promise<boolean>} True if channel is approved; false otherwise.
 */
export async function isChannelAllowed(identifier) {
    return _isAllowed(identifier);
}

/**
 * Checks whether the bot is currently switched on for a channel
 * (managedChannels.isActive). This is the check for anything that acts in a
 * channel; isChannelAllowed only answers whether the channel is approved.
 * Accepts either a Twitch User ID or a channel login name.
 * @param {string} identifier - The Twitch User ID or channel name.
 * @returns {Promise<boolean>} True if the bot is active for the channel.
 */
export async function isChannelActive(identifier) {
    return _isActive(identifier);
}

/**
 * Subscribes or unsubscribes EventSub for a channel based on its active status.
 * @param {String} channelName - Channel name
 * @param {Boolean} isActive - Whether the channel is active
 * @param {String} [twitchUserId] - Optional Twitch User ID (skips Helix lookup if provided)
 * @returns {Promise<boolean>} Whether any change was made
 */
export async function syncChannelWithEventSub(channelName, isActive, twitchUserId = null) {
    const cleanChannelName = channelName.toLowerCase().replace(/^#/, '');

    try {
        let userId = twitchUserId ? String(twitchUserId) : null;

        // Only fall back to login-name lookup if no ID was provided
        if (!userId) {
            const { getUsersByLogin } = await import('./helixClient.js');
            const users = await getUsersByLogin([cleanChannelName]);
            if (!users || users.length === 0) {
                logger.warn({ channel: cleanChannelName }, '[ChannelManager] Could not find user ID for channel');
                return false;
            }
            userId = users[0].id;
        }

        if (isActive) {
            // Subscribe to EventSub events for this channel
            logger.info(`[ChannelManager] Subscribing EventSub for channel: ${cleanChannelName}`);
            const { subscribeChannelChatMessage, subscribeStreamOnline, subscribeStreamOffline, subscribeChannelFollow, subscribeChannelSubscribe, subscribeChannelSubscriptionGift, subscribeChannelRaid } = await import('./twitchSubs.js');
            await subscribeChannelChatMessage(userId);
            await subscribeStreamOnline(userId);
            await subscribeStreamOffline(userId);
            // Celebration-related subscriptions (best-effort)
            await subscribeChannelFollow(userId).catch(() => {});
            await subscribeChannelSubscribe(userId).catch(() => {});
            await subscribeChannelSubscriptionGift(userId).catch(() => {});
            await subscribeChannelRaid(userId).catch(() => {});
            logger.info(`[ChannelManager] Successfully subscribed EventSub for channel: ${cleanChannelName}`);
            return true;
        } else {
            // Unsubscribe/delete EventSub subscriptions for this channel
            logger.info(`[ChannelManager] Removing EventSub subscriptions for channel: ${cleanChannelName}`);
            const { getEventSubSubscriptions, deleteEventSubSubscription } = await import('./twitchSubs.js');
            const result = await getEventSubSubscriptions('Channel deactivation cleanup', false);
            if (result.success && result.data?.data) {
                const channelSubs = result.data.data.filter(sub =>
                    sub.condition?.broadcaster_user_id === userId ||
                    sub.condition?.to_broadcaster_user_id === userId
                );
                for (const sub of channelSubs) {
                    await deleteEventSubSubscription(sub.id);
                }
                logger.info({ channel: cleanChannelName, count: channelSubs.length }, '[ChannelManager] Removed EventSub subscriptions');
            }
            return true;
        }
    } catch (error) {
        logger.error({ err: error, channel: cleanChannelName },
            `[ChannelManager] Error ${isActive ? 'subscribing' : 'unsubscribing'} EventSub for channel.`);
        return false;
    }
}



/**
 * Picks out the initial-snapshot documents whose active state no longer matches
 * what the startup fetch subscribed, so only those are synced with EventSub.
 * Returns nothing when no fetch has run — there is no baseline to compare with,
 * and re-syncing every channel would mean a Helix call per channel on boot.
 */
function changesMissedDuringStartup(changes) {
    if (!lastFetchedActiveNames) return [];
    return changes
        .filter(change => lastFetchedActiveNames.has(change.channelName.toLowerCase()) !== change.isActive)
        // Every initial-snapshot entry arrives as 'added', but these documents are
        // ones that changed after startup read them, so they are reported as such.
        .map(change => ({ ...change, type: 'modified' }));
}

/**
 * Sets up a listener for changes to the managedChannels collection.
 * When channels are added/modified, subscribes/unsubscribes EventSub accordingly.
 * @returns {Function} Unsubscribe function to stop listening for changes
 */
export function listenForChannelChanges() {
    const db = _getDb();
    let isInitialSnapshot = true;

    logger.info("[ChannelManager] Setting up listener for channel management changes (EventSub)...");

    const unsubscribe = db.collection(MANAGED_CHANNELS_COLLECTION)
        .onSnapshot(snapshot => {
            const changes = [];

            snapshot.docChanges().forEach(change => {
                const channelData = change.doc.data();
                // Defensive check for channelName
                if (channelData && typeof channelData.channelName === 'string') {
                    const normName = channelData.channelName.toLowerCase();
                    const devChannel = isDevChannel(normName);

                    // Update the caches in real-time. Every document is approved,
                    // active or not; only a deleted document revokes approval.
                    if (change.type === 'removed') {
                        if (!devChannel) {
                            removeAllowedChannel(channelData.channelName, channelData.twitchUserId);
                        }
                    } else if (channelData.isActive) {
                        setChannelActive(channelData.channelName, channelData.twitchUserId, true);
                    } else if (!isInitialSnapshot && !devChannel) {
                        setChannelActive(channelData.channelName, channelData.twitchUserId, false);
                    } else {
                        // Approve without switching off: on the initial snapshot a legacy
                        // duplicate doc could otherwise switch off a channel the active doc
                        // just switched on, and dev-mode channels configured in .env are
                        // isActive:false in Firestore by design.
                        addAllowedChannel(channelData.channelName, channelData.twitchUserId);
                    }

                    // Skip EventSub syncing for inactive dev-mode channels (they are explicitly managed by dev mode boot)
                    if (!devChannel || channelData.isActive) {
                        changes.push({
                            type: change.type,
                            channelName: channelData.channelName,
                            isActive: !!channelData.isActive,
                            docId: change.doc.id,
                            channelData: channelData
                        });
                    } else {
                        // Log that we're intentionally skipping this dev-channel event
                        logger.info({ channelName: channelData.channelName, isActive: channelData.isActive, changeType: change.type },
                            '[ChannelManager] Skipping EventSub sync for dev-configured channel (managed by dev-mode boot)');
                    }
                } else {
                    logger.warn({ docId: change.doc.id }, `[ChannelManager] Firestore listener detected change in document missing valid 'channelName'. Skipping processing for this change.`);
                }
            });

            // The initial snapshot mostly repeats what subscribeAllManagedChannels()
            // subscribed during startup, so it syncs nothing by default. The exception
            // is a channel switched on or off between that fetch and this listener
            // attaching: no other event covers that window, and the channel would stay
            // wrongly subscribed — or wrongly silent — until the next restart.
            let changesToSync = changes;
            if (isInitialSnapshot) {
                isInitialSnapshot = false;
                changesToSync = changesMissedDuringStartup(changes);
                logger.info(
                    `[ChannelManager] Initial snapshot: ${changes.length} channels loaded, ` +
                    `${changesToSync.length} changed since the startup fetch`
                );
            }

            if (changesToSync.length > 0) {
                logger.info(`[ChannelManager] Detected ${changesToSync.length} channel management changes.`);

                // Process the VALID changes
                changesToSync.forEach(change => {
                    // A deleted document is a deactivation as far as Twitch is concerned:
                    // without this its subscriptions keep delivering webhooks that every
                    // handler then discards.
                    const shouldBeSubscribed = change.type === 'removed' ? false : change.isActive;

                    // Sync channel with EventSub (subscribe if active, unsubscribe if inactive)
                    // Pass stored twitchUserId to avoid login-name lookups that break on renames
                    syncChannelWithEventSub(change.channelName, shouldBeSubscribed, change.channelData?.twitchUserId)
                        .catch(err => {
                            logger.error({ err, channel: change.channelName, docId: change.docId },
                                `[ChannelManager] Error processing channel change via listener`);
                        });
                });
            }
        }, error => {
            logger.error({ err: error }, "[ChannelManager] Error in channel changes listener.");
        });

    logger.info("[ChannelManager] Channel management listener set up successfully.");

    return unsubscribe;
}

/**
 * Gets a list of all channels (both active and inactive) from the managedChannels collection.
 * @returns {Promise<Array<{channelName: string, isActive: boolean, displayName: string, email: string|null}>>}
 */
export async function getAllManagedChannels() {
    const db = _getDb();

    try {
        const snapshot = await db.collection(MANAGED_CHANNELS_COLLECTION).get();

        const channels = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            channels.push({
                channelName: data.channelName.toLowerCase(),
                isActive: !!data.isActive,
                displayName: data.displayName || data.channelName,
                email: data.email || null,
                addedAt: data.addedAt ? data.addedAt.toDate() : null,
                lastStatusChange: data.lastStatusChange ? data.lastStatusChange.toDate() : null
            });
        });

        logger.debug(`[ChannelManager] Retrieved ${channels.length} managed channels.`);
        return channels;
    } catch (error) {
        logger.error({ err: error }, "[ChannelManager] Error fetching all managed channels.");
        throw new ChannelManagerError("Failed to fetch all managed channels.", error);
    }
}

/**
 * Gets detailed information about a specific managed channel.
 * @param {string} channelName - The channel name to get information for
 * @returns {Promise<{channelName: string, isActive: boolean, displayName: string, email: string|null, twitchUserId: string|null}|null>}
 */
export async function getChannelInfo(channelName) {
    const db = _getDb();
    const cleanChannelName = channelName.toLowerCase().replace(/^#/, '');

    try {
        // Query by channelName field since docs are keyed by broadcaster ID
        const snapshot = await db.collection(MANAGED_CHANNELS_COLLECTION)
            .where('channelName', '==', cleanChannelName)
            .limit(1)
            .get();

        if (snapshot.empty) {
            logger.debug(`[ChannelManager] Channel ${cleanChannelName} not found in managedChannels.`);
            return null;
        }

        const doc = snapshot.docs[0];
        const data = doc.data();
        return {
            channelName: data.channelName?.toLowerCase() || cleanChannelName,
            isActive: !!data.isActive,
            displayName: data.displayName || data.channelName || cleanChannelName,
            email: data.email || null,
            twitchUserId: data.twitchUserId || null,
            addedAt: data.addedAt ? data.addedAt.toDate() : null,
            lastStatusChange: data.lastStatusChange ? data.lastStatusChange.toDate() : null,
            lastLoginAt: data.lastLoginAt ? data.lastLoginAt.toDate() : null
        };
    } catch (error) {
        logger.error({ err: error, channel: cleanChannelName }, "[ChannelManager] Error fetching channel info.");
        throw new ChannelManagerError(`Failed to fetch info for channel ${cleanChannelName}.`, error);
    }
}

