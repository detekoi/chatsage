// src/components/twitch/channelManager.js
import { Firestore } from '@google-cloud/firestore';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';
import { updateAllowedChannels, addAllowedChannel, removeAllowedChannel, isChannelAllowed as _isAllowed } from '../../lib/allowList.js';
// --- Firestore Client Initialization ---
let db = null; // Firestore database instance

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
 * Initializes the Google Cloud Firestore client.
 * Relies on Application Default Credentials or GOOGLE_APPLICATION_CREDENTIALS environment variable.
 */
export async function initializeChannelManager() {
    logger.info("[ChannelManager] Initializing Google Cloud Firestore client for channel management...");
    try {
        // Create a new client
        db = new Firestore();

        logger.debug("[ChannelManager] Firestore client created, testing connection...");

        // Test connection by fetching a document
        const testQuery = db.collection(MANAGED_CHANNELS_COLLECTION).limit(1);
        logger.debug("[ChannelManager] Executing test query...");
        const result = await testQuery.get();

        logger.debug(`[ChannelManager] Test query successful. Found ${result.size} documents.`);
        logger.info("[ChannelManager] Google Cloud Firestore client initialized and connected.");
    } catch (error) {
        logger.fatal({
            err: error,
            message: error.message,
            code: error.code,
            stack: error.stack,
            projectId: process.env.GOOGLE_CLOUD_PROJECT || 'unknown'
        }, "[ChannelManager] CRITICAL: Failed to initialize Google Cloud Firestore for channel management.");

        // Log credential path if set
        const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        if (credPath) {
            logger.fatal(`[ChannelManager] GOOGLE_APPLICATION_CREDENTIALS is set to: ${credPath}`);
        } else {
            logger.fatal("[ChannelManager] GOOGLE_APPLICATION_CREDENTIALS environment variable is not set.");
        }

        // Application cannot proceed without storage
        throw error;
    }
}

// getChannelManager function removed - use getFirestoreDb() instead

/**
 * Gets the Firestore database instance.
 * @returns {Firestore} Firestore DB instance.
 * @throws {Error} If storage is not initialized.
 */
function _getDb() {
    if (!db) {
        throw new Error("[ChannelManager] Storage not initialized. Call initializeChannelManager first.");
    }
    return db;
}

/**
 * Retrieves all active managed channels from Firestore.
 * @returns {Promise<Array<{name: string, twitchUserId: string|null}>>} Array of channel objects.
 */
export async function getActiveManagedChannels() {
    const dbInstance = _getDb();
    logger.info("[ChannelManager] Fetching active managed channels from Firestore...");

    try {
        const snapshot = await dbInstance.collection(MANAGED_CHANNELS_COLLECTION)
            .where('isActive', '==', true)
            .get();

        const channels = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data && typeof data.channelName === 'string') {
                channels.push({
                    name: data.channelName.toLowerCase(),
                    twitchUserId: data.twitchUserId || null
                });
            } else {
                logger.warn({ docId: doc.id }, `[ChannelManager] Document in managedChannels missing valid 'channelName'. Skipping.`);
            }
        });

        // Populate the allow-list cache from Firestore (the single source of truth)
        updateAllowedChannels(channels);

        const channelNames = channels.map(ch => ch.name);
        logger.info(`[ChannelManager] Successfully fetched ${channelNames.length} active managed channels.`);
        logger.debug(`[ChannelManager] Active channels: ${channelNames.join(', ')}`);

        return channels;
    } catch (error) {
        logger.error({ err: error }, "[ChannelManager] Error fetching active managed channels.");
        throw new ChannelManagerError("Failed to fetch active managed channels.", error);
    }
}

/**
 * Checks whether a given channel is allowed (active) according to the in-memory
 * cache populated from Firestore managedChannels.
 * Accepts either a Twitch User ID or a channel login name.
 * @param {string} identifier - The Twitch User ID or channel name.
 * @returns {Promise<boolean>} True if channel is allowed; false otherwise.
 */
export async function isChannelAllowed(identifier) {
    return _isAllowed(identifier);
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
            const { subscribeChannelChatMessage, subscribeStreamOnline, subscribeStreamOffline } = await import('./twitchSubs.js');
            await subscribeChannelChatMessage(userId);
            await subscribeStreamOnline(userId);
            await subscribeStreamOffline(userId);
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

let isSyncing = false;

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
                    // Update allow-list cache in real-time
                    if (channelData.isActive && channelData.twitchUserId) {
                        addAllowedChannel(channelData.channelName, channelData.twitchUserId);
                    } else if (!channelData.isActive) {
                        removeAllowedChannel(channelData.channelName, channelData.twitchUserId);
                    }

                    changes.push({
                        type: change.type,
                        channelName: channelData.channelName,
                        isActive: !!channelData.isActive,
                        docId: change.doc.id,
                        channelData: channelData
                    });
                } else {
                    logger.warn({ docId: change.doc.id }, `[ChannelManager] Firestore listener detected change in document missing valid 'channelName'. Skipping processing for this change.`);
                }
            });

            // Skip EventSub sync on initial snapshot — subscribeAllManagedChannels()
            // already handled these during startup. Allow-list updates above still run.
            if (isInitialSnapshot) {
                isInitialSnapshot = false;
                logger.info(`[ChannelManager] Initial snapshot: ${changes.length} channels loaded (skipping EventSub sync)`);
                return;
            }

            if (changes.length > 0) {
                logger.info(`[ChannelManager] Detected ${changes.length} channel management changes.`);

                // Process the VALID changes
                changes.forEach(async (change) => {
                    if (change.type === 'added' || change.type === 'modified') {
                        // Sync channel with EventSub (subscribe if active, unsubscribe if inactive)
                        // Pass stored twitchUserId to avoid login-name lookups that break on renames
                        syncChannelWithEventSub(change.channelName, change.isActive, change.channelData?.twitchUserId)
                            .catch(err => {
                                logger.error({ err, channel: change.channelName, docId: change.docId },
                                    `[ChannelManager] Error processing channel change via listener`);
                            });
                    }
                    // Optionally handle 'removed' type if needed
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

