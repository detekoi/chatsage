// src/components/twitch/channelManager.js
import { Firestore } from '@google-cloud/firestore';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';
import { ensureAdBreakSubscriptionForBroadcaster } from './twitchSubs.js';

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
 * @returns {Promise<string[]>} Array of channel names.
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
                channels.push(data.channelName.toLowerCase());
            } else {
                logger.warn({ docId: doc.id }, `[ChannelManager] Document in managedChannels missing valid 'channelName'. Skipping.`);
            }
        });
        
        logger.info(`[ChannelManager] Successfully fetched ${channels.length} active managed channels.`);
        logger.debug(`[ChannelManager] Active channels: ${channels.join(', ')}`);
        
        return channels;
    } catch (error) {
        logger.error({ err: error }, "[ChannelManager] Error fetching active managed channels.");
        throw new ChannelManagerError("Failed to fetch active managed channels.", error);
    }
}

/**
 * Checks whether a given channel is allowed (active) according to managedChannels in Firestore.
 * @param {string} channelName - The Twitch channel name (with or without leading '#').
 * @returns {Promise<boolean>} True if channel exists in allow-list and is active; false otherwise (or on error).
 */
export async function isChannelAllowed(channelName) {
    const db = _getDb();
    const cleanChannelName = (channelName || '').toLowerCase().replace(/^#/, '');
    if (!cleanChannelName) {
        return false;
    }
    // Environment allow-list acts as an additional filter: if configured, channel must be in it.
    // It does NOT bypass Firestore; Firestore is the source of truth for active status.
    try {
        let hasEnvAllowlistConfigured = Array.isArray(config.app.allowedChannels) && config.app.allowedChannels.length > 0;
        let isInEnvAllowlist = hasEnvAllowlistConfigured && config.app.allowedChannels.includes(cleanChannelName);
        // If not configured via env and a secret name is provided, attempt to load list from Secret Manager
        if (!hasEnvAllowlistConfigured && config.secrets.allowedChannelsSecretName) {
            try {
                const { getSecretValue } = await import('../../lib/secretManager.js');
                const secret = await getSecretValue(config.secrets.allowedChannelsSecretName);
                if (secret) {
                    const secretList = secret.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
                    hasEnvAllowlistConfigured = secretList.length > 0;
                    isInEnvAllowlist = secretList.includes(cleanChannelName);
                }
            } catch (secretErr) {
                logger.error({ err: secretErr }, '[ChannelManager] Error loading allowed channels from Secret Manager');
            }
        }
        if (hasEnvAllowlistConfigured && !isInEnvAllowlist) {
            logger.warn({ channel: cleanChannelName }, '[ChannelManager] Channel not present in ALLOWED_CHANNELS; access denied.');
            return false;
        }
    } catch (envErr) {
        logger.error({ err: envErr }, '[ChannelManager] Error checking environment allow-list');
        // On env allow-list check failure, continue to Firestore check but stay conservative if needed
    }
    try {
        const snapshot = await db
            .collection(MANAGED_CHANNELS_COLLECTION)
            .where('channelName', '==', cleanChannelName)
            .where('isActive', '==', true)
            .limit(1)
            .get();
        const allowed = !snapshot.empty;
        if (!allowed) {
            logger.warn({ channel: cleanChannelName }, '[ChannelManager] Channel not found in allow-list or not active.');
        }
        return allowed;
    } catch (error) {
        logger.error({ err: error, channel: cleanChannelName }, '[ChannelManager] Error checking channel allow-list status.');
        return false;
    }
}

/**
 * Joins or leaves a channel based on its current status in Firestore.
 * @param {Object} ircClient - The TMI.js client instance
 * @param {String} channelName - Channel name to join or part
 * @param {Boolean} isActive - Whether the channel is active
 * @returns {Promise<void>}
 */
export async function syncChannelWithIrc(ircClient, channelName, isActive) {
    const cleanChannelName = channelName.toLowerCase().replace(/^#/, '');
    const channelWithHash = `#${cleanChannelName}`;

    try {
        // Check if IRC is connected
        const ircState = ircClient?.readyState?.() || 'CLOSED';
        if (ircState !== 'OPEN') {
            logger.debug({
                channel: cleanChannelName,
                ircState,
                isActive
            }, '[ChannelManager] IRC not connected - skipping channel sync');
            return false;
        }

        // Check if we're already in the channel
        const currentChannels = ircClient.getChannels().map(ch => ch.toLowerCase());
        const isCurrentlyJoined = currentChannels.includes(channelWithHash.toLowerCase());

        if (isActive && !isCurrentlyJoined) {
            // Join channel if it's active but we're not in it
            logger.info(`[ChannelManager] Joining channel: ${cleanChannelName}`);
            await ircClient.join(channelWithHash);
            logger.info(`[ChannelManager] Successfully joined channel: ${cleanChannelName}`);
            return true;
        } else if (!isActive && isCurrentlyJoined) {
            // Leave channel if it's not active but we're in it
            logger.info(`[ChannelManager] Leaving channel: ${cleanChannelName}`);
            await ircClient.part(channelWithHash);
            logger.info(`[ChannelManager] Successfully left channel: ${cleanChannelName}`);
            return true;
        }

        // No action needed
        return false;
    } catch (error) {
        logger.error({ err: error, channel: cleanChannelName },
            `[ChannelManager] Error ${isActive ? 'joining' : 'leaving'} channel.`);
        throw new ChannelManagerError(
            `Failed to ${isActive ? 'join' : 'leave'} channel ${cleanChannelName}.`,
            error
        );
    }
}

let isSyncing = false;

/**
 * Synchronizes the IRC client's joined channels with the active managed channels.
 * @param {Object} ircClient - The TMI.js client instance
 * @returns {Promise<{joined: string[], parted: string[]}>} Channels joined and parted
 */
export async function syncManagedChannelsWithIrc(ircClient) {
    if (isSyncing) {
        logger.warn('[ChannelManager] Sync already in progress. Skipping.');
        return;
    }

    isSyncing = true;

    try {
        const db = _getDb();
        const snapshot = await db.collection(MANAGED_CHANNELS_COLLECTION).get();
        
        const currentChannels = ircClient.getChannels().map(ch => ch.toLowerCase().replace(/^#/, ''));
        logger.debug(`[ChannelManager] Currently joined channels: ${currentChannels.join(', ')}`);
        
        const joinedChannels = [];
        const partedChannels = [];
        
        const promises = [];
        
        snapshot.forEach(doc => {
            const channelData = doc.data();
            if (channelData && typeof channelData.channelName === 'string') {
                const channelName = channelData.channelName.toLowerCase();
                const isActive = !!channelData.isActive;
                const isCurrentlyJoined = currentChannels.includes(channelName);
                
                if (isActive && !isCurrentlyJoined) {
                    // Need to join
                    promises.push(
                        syncChannelWithIrc(ircClient, channelName, true)
                            .then(() => joinedChannels.push(channelName))
                            .catch(err => {
                                logger.error({ err, channel: channelName }, 
                                    `[ChannelManager] Error joining channel ${channelName}`);
                            })
                    );
                } else if (!isActive && isCurrentlyJoined) {
                    // Need to leave
                    promises.push(
                        syncChannelWithIrc(ircClient, channelName, false)
                            .then(() => partedChannels.push(channelName))
                            .catch(err => {
                                logger.error({ err, channel: channelName }, 
                                    `[ChannelManager] Error leaving channel ${channelName}`);
                            })
                    );
                }

                // Handle ad break subscriptions
                const { adNotificationsEnabled, twitchUserAccessToken, twitchUserId } = channelData;
                if (isActive && adNotificationsEnabled && twitchUserAccessToken && twitchUserId) {
                    promises.push(
                        ensureAdBreakSubscriptionForBroadcaster(twitchUserId, true, twitchUserAccessToken)
                            .catch(e => logger.error({ err: e, channel: channelName }, 'Error ensuring ad break subscription during sync'))
                    );
                } else if (isActive && !adNotificationsEnabled && twitchUserId) {
                    promises.push(
                        ensureAdBreakSubscriptionForBroadcaster(twitchUserId, false)
                            .catch(e => logger.error({ err: e, channel: channelName }, 'Error ensuring ad break subscription during sync'))
                    );
                }

            } else {
                logger.warn({ docId: doc.id }, `[ChannelManager] Document in managedChannels missing valid 'channelName' during sync. Skipping.`);
            }
        });
        
        await Promise.all(promises);
        
        logger.info(
            `[ChannelManager] Channel sync complete. Joined: ${joinedChannels.length}, Parted: ${partedChannels.length}`
        );
        
        return { joined: joinedChannels, parted: partedChannels };
    } catch (error) {
        logger.error({ err: error }, "[ChannelManager] Error syncing managed channels with IRC.");
        throw new ChannelManagerError("Failed to sync managed channels with IRC.", error);
    } finally {
        isSyncing = false;
    }
}

/**
 * Sets up a listener for changes to the managedChannels collection.
 * @param {Object} ircClient - The TMI.js client instance 
 * @returns {Function} Unsubscribe function to stop listening for changes
 */
export function listenForChannelChanges(ircClient) {
    const db = _getDb();
    
    logger.info("[ChannelManager] Setting up listener for channel management changes...");
    
    const unsubscribe = db.collection(MANAGED_CHANNELS_COLLECTION)
        .onSnapshot(snapshot => {
            const changes = [];
            
            snapshot.docChanges().forEach(change => {
                const channelData = change.doc.data();
                // Defensive check for channelName
                if (channelData && typeof channelData.channelName === 'string') {
                    changes.push({
                        type: change.type,
                        channelName: channelData.channelName, // Now safe
                        isActive: !!channelData.isActive,
                        docId: change.doc.id, // For logging
                        channelData: channelData // Pass the whole data object
                    });
                } else {
                    logger.warn({ docId: change.doc.id }, `[ChannelManager] Firestore listener detected change in document missing valid 'channelName'. Skipping processing for this change.`);
                }
            });
            
            if (changes.length > 0) {
                logger.info(`[ChannelManager] Detected ${changes.length} channel management changes.`);
                
                // Process the VALID changes
                changes.forEach(async (change) => {
                    if (change.type === 'added' || change.type === 'modified') {
                        // Sync channel with IRC (join if active, part if inactive)
                        syncChannelWithIrc(ircClient, change.channelName, change.isActive)
                            .catch(err => {
                                logger.error({ err, channel: change.channelName, docId: change.docId },
                                    `[ChannelManager] Error processing channel change via listener`);
                            });

                        // If channel was just added and is active, check if it's already live
                        if (change.type === 'added' && change.isActive) {
                            try {
                                const { getContextManager } = await import('../context/contextManager.js');
                                const contextManager = getContextManager();
                                const context = contextManager.getContextForLLM(change.channelName, 'system', 'channel-added-check');

                                // Check if stream is live (has game data and not N/A)
                                const isLive = context && context.streamGame && context.streamGame !== 'N/A' && context.streamGame !== null;

                                if (isLive) {
                                    logger.info({ channel: change.channelName, game: context.streamGame },
                                        '[ChannelManager] Newly added channel is already live - ensuring IRC connection');

                                    // Check if in LAZY_CONNECT mode and IRC not connected yet
                                    const isLazyConnect = process.env.LAZY_CONNECT === '1' || process.env.LAZY_CONNECT === 'true';
                                    const ircState = ircClient?.readyState?.() || 'CLOSED';

                                    if (isLazyConnect && ircState !== 'OPEN' && ircState !== 'CONNECTING') {
                                        logger.info('[ChannelManager] LAZY_CONNECT mode detected - triggering IRC connection for live channel');
                                        const { connectIrcClient } = await import('./ircClient.js');
                                        await connectIrcClient();
                                    }
                                }
                            } catch (err) {
                                logger.error({ err, channel: change.channelName }, '[ChannelManager] Error checking if newly added channel is live');
                            }
                        }

                        const { adNotificationsEnabled, twitchUserAccessToken, twitchUserId } = change.channelData;

                        if (adNotificationsEnabled && twitchUserAccessToken && twitchUserId) {
                            try {
                                await ensureAdBreakSubscriptionForBroadcaster(twitchUserId, true, twitchUserAccessToken);
                            } catch (e) {
                                logger.error({ err: e, channel: change.channelName }, 'Error ensuring ad break subscription');
                            }
                        } else if (!adNotificationsEnabled && twitchUserId) {
                            try {
                                await ensureAdBreakSubscriptionForBroadcaster(twitchUserId, false);
                            } catch (e) {
                                logger.error({ err: e, channel: change.channelName }, 'Error ensuring ad break subscription');
                            }
                        }
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
        const docRef = db.collection(MANAGED_CHANNELS_COLLECTION).doc(cleanChannelName);
        const doc = await docRef.get();
        
        if (!doc.exists) {
            logger.debug(`[ChannelManager] Channel ${cleanChannelName} not found in managedChannels.`);
            return null;
        }
        
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

