// src/components/geo/geoStorage.js
import { Firestore, FieldValue } from '@google-cloud/firestore';
import logger from '../../lib/logger.js';

// --- Firestore Client Initialization ---
let db = null; // Firestore database instance

// Collection names
const CONFIG_COLLECTION = 'geoGameConfigs';
const STATS_COLLECTION = 'geoPlayerStats';
const HISTORY_COLLECTION = 'geoGameHistory';

/**
 * Custom error class for storage operations.
 */
export class StorageError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'StorageError';
        this.cause = cause;
    }
}

/**
 * Initializes the Google Cloud Firestore client.
 * Relies on Application Default Credentials or GOOGLE_APPLICATION_CREDENTIALS environment variable.
 */
async function initializeStorage() {
    logger.info("[GeoStorage-GCloud] Initializing Google Cloud Firestore client...");
    try {
        // Log before creating client - will help identify if constructor fails
        logger.debug("[GeoStorage-GCloud] Creating new Firestore client instance...");
        
        // Create a new client
        db = new Firestore();
        
        logger.debug("[GeoStorage-GCloud] Firestore client created, testing connection...");
        
        // Test connection by fetching a document
        const testQuery = db.collection(CONFIG_COLLECTION).limit(1);
        logger.debug("[GeoStorage-GCloud] Executing test query...");
        const result = await testQuery.get();
        
        logger.debug(`[GeoStorage-GCloud] Test query successful. Found ${result.size} documents.`);
        logger.info("[GeoStorage-GCloud] Google Cloud Firestore client initialized and connected.");
    } catch (error) {
        logger.fatal({ 
            err: error, 
            message: error.message,
            code: error.code,
            stack: error.stack,
            projectId: process.env.GOOGLE_CLOUD_PROJECT || 'unknown'
        }, "[GeoStorage-GCloud] CRITICAL: Failed to initialize Google Cloud Firestore. Check credentials (GOOGLE_APPLICATION_CREDENTIALS).");
        
        // Log credential path if set
        const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        if (credPath) {
            logger.fatal(`[GeoStorage-GCloud] GOOGLE_APPLICATION_CREDENTIALS is set to: ${credPath}`);
        } else {
            logger.fatal("[GeoStorage-GCloud] GOOGLE_APPLICATION_CREDENTIALS environment variable is not set.");
        }
        
        // Application cannot proceed without storage
        throw error;
    }
}

/**
 * Gets the Firestore database instance.
 * @returns {Firestore} Firestore DB instance.
 * @throws {Error} If storage is not initialized.
 */
function _getDb() {
    if (!db) {
        throw new Error("[GeoStorage-GCloud] Storage not initialized. Call initializeStorage first.");
    }
    return db;
}

// --- Public API ---

/**
 * Loads the configuration for a specific channel from Firestore.
 * @param {string} channelName
 * @returns {Promise<object|null>} The config object or null if not found/error.
 */
async function loadChannelConfig(channelName) {
    const db = _getDb();
    const docRef = db.collection(CONFIG_COLLECTION).doc(channelName.toLowerCase());
    try {
        const docSnap = await docRef.get();
        if (docSnap.exists) {
            logger.debug(`[GeoStorage-GCloud] Loaded config for channel ${channelName}`);
            return docSnap.data();
        } else {
            logger.debug(`[GeoStorage-GCloud] No config found for channel ${channelName}`);
            return null; // Not found is not an error
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `[GeoStorage-GCloud] Error loading config for channel ${channelName}`);
        throw new StorageError(`Failed to load config for ${channelName}`, error);
    }
}

/**
 * Saves or updates the configuration for a specific channel in Firestore.
 * @param {string} channelName
 * @param {object} config - The complete config object to save.
 * @returns {Promise<boolean>} True on success, false on failure.
 */
async function saveChannelConfig(channelName, config) {
    const db = _getDb();
    const docRef = db.collection(CONFIG_COLLECTION).doc(channelName.toLowerCase());
    try {
        await docRef.set(config, { merge: true });
        logger.debug(`[GeoStorage-GCloud] Saved config for channel ${channelName}`);
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `[GeoStorage-GCloud] Error saving config for channel ${channelName}`);
        throw new StorageError(`Failed to save config for ${channelName}`, error);
    }
}

/**
 * Records the result of a completed game in Firestore.
 * @param {object} gameResultDetails - Details like winner, location, duration, channel etc.
 * @returns {Promise<boolean>} True on success, false on failure.
 */
async function recordGameResult(gameResultDetails) {
    const db = _getDb();
    const colRef = db.collection(HISTORY_COLLECTION);
    // Use console.log for maximum visibility
    console.log(`RECORD GAME RESULT START: Attempting to save details:`, JSON.stringify(gameResultDetails, null, 2));
    try {
        const dataToSave = {
            ...gameResultDetails,
            timestamp: FieldValue.serverTimestamp()
        };
        await colRef.add(dataToSave);
        console.log(`RECORD GAME RESULT SUCCESS: Document added for channel ${gameResultDetails?.channel}, location ${gameResultDetails?.location}.`);
    } catch (error) {
        console.error(`RECORD GAME RESULT ERROR: Error adding document for channel ${gameResultDetails?.channel}. Error:`, error);
        throw new StorageError('Failed to record game result', error);
    }
}

/**
 * Updates player scores/stats using Firestore atomic increments.
 * @param {string} username - Lowercase username.
 * @param {string} channelName - Lowercase channel name.
 * @param {number} points - Points to add for the correct guess.
 * @param {string} [displayName] - Optional display name to store with the player record.
 * @returns {Promise<void>}
 * @throws {StorageError} On failure to update.
 */
async function updatePlayerScore(username, channelName, points = 0, displayName = null) {
    const db = _getDb();
    const lowerUsername = username.toLowerCase();
    const lowerChannel = channelName.toLowerCase();
    const docRef = db.collection(STATS_COLLECTION).doc(lowerUsername);
    try {
        const updateData = {
            globalPoints: FieldValue.increment(points),
            globalWins: FieldValue.increment(points > 0 ? 1 : 0),
            globalParticipation: FieldValue.increment(1),
            ...(points > 0 && { lastWinTimestamp: FieldValue.serverTimestamp() }),
            channels: {
                [lowerChannel]: {
                    points: FieldValue.increment(points),
                    wins: FieldValue.increment(points > 0 ? 1 : 0),
                    participation: FieldValue.increment(1),
                    ...(points > 0 && { lastWinTimestamp: FieldValue.serverTimestamp() })
                }
            }
        };
        if (displayName) {
            updateData.displayName = displayName;
        }
        await docRef.set(updateData, { merge: true });
        logger.debug(`[GeoStorage-GCloud] Updated stats for player ${lowerUsername} in channel ${lowerChannel}. Points added: ${points}`);
    } catch (error) {
        logger.error({ err: error, player: lowerUsername, channel: lowerChannel }, `[GeoStorage-GCloud] Error updating player score for ${lowerUsername} in ${lowerChannel}`);
        throw new StorageError(`Failed to update player score for ${lowerUsername} in ${lowerChannel}`, error);
    }
}

/**
 * Retrieves stats for a specific player.
 * @param {string} username - Lowercase username.
 * @param {string} [channelName] - Optional channel name to get channel-specific stats.
 * @returns {Promise<object|null>} Player stats object or null if not found/error.
 */
async function getPlayerStats(username, channelName = null) {
    const db = _getDb();
    const lowerUsername = username.toLowerCase();
    const docRef = db.collection(STATS_COLLECTION).doc(lowerUsername);

    try {
        const docSnap = await docRef.get();
        if (docSnap.exists) {
            const data = docSnap.data();
            const globalStats = {
                points: data.globalPoints ?? data.globalWins ?? 0,
                wins: data.globalWins ?? data.wins ?? 0,
                participation: data.globalParticipation ?? data.participation ?? 0,
                displayName: data.displayName || lowerUsername,
                lastWinTimestamp: data.lastWinTimestamp || null,
                channelsData: data.channels || {}
            };

            if (channelName) {
                const lowerChannel = channelName.toLowerCase();
                const channelData = data.channels?.[lowerChannel];
                const channelStats = channelData ? {
                    points: channelData.points ?? channelData.wins ?? 0,
                    wins: channelData.wins ?? 0,
                    participation: channelData.participation ?? 0,
                    lastWinTimestamp: channelData.lastWinTimestamp || null
                } : { points: 0, wins: 0, participation: 0, lastWinTimestamp: null };

                return {
                    ...globalStats,
                    channelStats: channelStats,
                };
            }

            return globalStats;
        } else {
            return null; // Player has no stats yet
        }
    } catch (error) {
        logger.error({
            err: error,
            player: lowerUsername,
            channel: channelName
        }, `[GeoStorage-GCloud] Error getting player stats for ${lowerUsername}`);
        throw new StorageError(`Failed to get player stats for ${lowerUsername}`, error);
    }
}

/**
 * Retrieves the top N players based on points.
 * @param {string} [channelName=null] - Optional channel name for channel-specific leaderboard.
 * @param {number} [limit=10] - Number of top players to retrieve.
 * @returns {Promise<Array<{id: string, data: object}>>} Array of player objects {id: username, data: {points, wins, participation, ...}}.
 */
async function getLeaderboard(channelName = null, limit = 10) {
    const db = _getDb();
    const colRef = db.collection(STATS_COLLECTION);
    const leaderboard = [];

    try {
        let snapshot;

        if (channelName) {
            const lowerChannel = channelName.toLowerCase();
            logger.debug(`[GeoStorage-GCloud] Retrieving channel-specific leaderboard (points) for ${lowerChannel}`);
            const fieldPath = `channels.${lowerChannel}.points`;

            try {
                snapshot = await colRef
                    .orderBy(fieldPath, 'desc')
                    .limit(limit)
                    .get();
            } catch (indexError) {
                logger.warn({ err: indexError, channel: lowerChannel }, `[GeoStorage-GCloud] Index likely missing for direct channel points sort. Falling back to manual sort.`);
                const participationFieldPath = `channels.${lowerChannel}.participation`;
                const allSnapshot = await colRef
                    .where(participationFieldPath, '>', 0)
                    .limit(limit * 5)
                    .get();

                const players = [];
                allSnapshot.forEach(doc => {
                    const data = doc.data();
                    const channelData = data.channels?.[lowerChannel];
                    if (channelData) {
                        players.push({
                            id: doc.id,
                            data: {
                                displayName: data.displayName || doc.id,
                                channelPoints: channelData.points ?? channelData.wins ?? 0,
                                channelWins: channelData.wins ?? 0,
                                channelParticipation: channelData.participation ?? 0,
                            }
                        });
                    }
                });
                players.sort((a, b) => b.data.channelPoints - a.data.channelPoints);
                return players.slice(0, limit);
            }

            snapshot.forEach(doc => {
                const data = doc.data();
                const channelData = data.channels?.[lowerChannel];
                leaderboard.push({
                    id: doc.id,
                    data: {
                        displayName: data.displayName || doc.id,
                        channelPoints: channelData?.points ?? channelData?.wins ?? 0,
                        channelWins: channelData?.wins ?? 0,
                        channelParticipation: channelData?.participation ?? 0,
                    }
                });
            });
            logger.debug(`[GeoStorage-GCloud] Retrieved channel leaderboard (points) with ${leaderboard.length} players for ${lowerChannel}.`);
            return leaderboard;

        } else {
            snapshot = await colRef.orderBy('globalPoints', 'desc').limit(limit).get();
            snapshot.forEach(doc => {
                const data = doc.data();
                leaderboard.push({
                    id: doc.id,
                    data: {
                        displayName: data.displayName || doc.id,
                        points: data.globalPoints ?? data.globalWins ?? 0,
                        wins: data.globalWins ?? data.wins ?? 0,
                        participation: data.globalParticipation ?? data.participation ?? 0
                    }
                });
            });

            logger.debug(`[GeoStorage-GCloud] Retrieved global leaderboard (points) with ${leaderboard.length} players.`);
            return leaderboard;
        }
    } catch (error) {
        logger.error({
            err: error,
            channel: channelName || 'global'
        }, `[GeoStorage-GCloud] Error retrieving leaderboard.`);
        throw new StorageError(`Failed to retrieve leaderboard for ${channelName || 'global'}`, error);
    }
}

/**
 * Retrieves a list of recently played target locations for a channel.
 * @param {string} channelName - Lowercase channel name.
 * @param {number} [limit=10] - How many recent locations to retrieve.
 * @returns {Promise<string[]>} An array of recent location names.
 */
async function getRecentLocations(channelName, limit = 10) {
    const db = _getDb();
    const colRef = db.collection(HISTORY_COLLECTION);
    const lowerChannelName = channelName.toLowerCase();
    let snapshot;
    try {
        try {
            snapshot = await colRef
                .where('channel', '==', lowerChannelName)
                .orderBy('timestamp', 'desc')
                .limit(limit)
                .get();
        } catch (indexError) {
            if (indexError.code === 9 && indexError.message.includes('index')) {
                logger.warn({ 
                    channel: lowerChannelName,
                    indexUrl: indexError.message.includes('https://') ? 
                        indexError.message.substring(indexError.message.indexOf('https://')) : 'not found'
                }, `[GeoStorage-GCloud] Firestore index not created yet for channel+timestamp query. Using fallback query.`);
                snapshot = await colRef
                    .where('channel', '==', lowerChannelName)
                    .limit(limit * 2)
                    .get();
            } else {
                throw indexError;
            }
        }
        const recentLocations = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.location) {
                const primaryName = data.location.split('/')[0].trim();
                if (primaryName) {
                    recentLocations.push(primaryName);
                }
            }
        });
        logger.debug(`[GeoStorage-GCloud] Found ${recentLocations.length} recent locations for channel ${lowerChannelName}.`);
        return recentLocations;
    } catch (error) {
        logger.error({ err: error, channel: lowerChannelName }, `[GeoStorage-GCloud] Error getting recent locations for channel ${lowerChannelName}`);
        throw new StorageError(`Failed to get recent locations for ${lowerChannelName}`, error);
    }
}

/**
 * Clears leaderboard data (wins, participation) for a specific channel
 * by updating relevant player documents in Firestore.
 * WARNING: This iterates through player documents and can be resource-intensive
 * if many players have participated in the channel.
 * @param {string} channelName - Lowercase channel name.
 * @returns {Promise<{success: boolean, message: string, clearedCount: number}>}
 */
async function clearChannelLeaderboardData(channelName) {
    const db = _getDb();
    const lowerChannel = channelName.toLowerCase();
    const statsCollection = db.collection(STATS_COLLECTION);
    let clearedCount = 0;
    const batchSize = 100; // Process in batches
    let lastVisible = null; // For pagination

    logger.info(`[GeoStorage-GCloud] Starting leaderboard clear process for channel: ${lowerChannel}`);

    try {
        const fieldPath = `channels.${lowerChannel}`;
        let query = statsCollection.where(fieldPath, '!=', null).limit(batchSize);

        // eslint-disable-next-line no-constant-condition
        while (true) {
            const snapshot = await query.get();
            if (snapshot.empty) {
                break; // No more documents found
            }

            const batch = db.batch();
            snapshot.docs.forEach(doc => {
                const updateData = {
                    [`channels.${lowerChannel}`]: FieldValue.delete()
                };
                batch.update(doc.ref, updateData);
                clearedCount++;
            });

            await batch.commit();
            logger.debug(`[GeoStorage-GCloud] Cleared leaderboard data batch for ${snapshot.size} players in channel ${lowerChannel}. Total cleared: ${clearedCount}`);

            if (snapshot.size < batchSize) {
                break; // Last page processed
            }
            lastVisible = snapshot.docs[snapshot.docs.length - 1];
            query = statsCollection.where(fieldPath, '!=', null).startAfter(lastVisible).limit(batchSize);

            await new Promise(resolve => setTimeout(resolve, 50));
        }

        logger.info(`[GeoStorage-GCloud] Successfully cleared leaderboard data for ${clearedCount} players in channel ${lowerChannel}.`);
        return { success: true, message: `Successfully cleared leaderboard data for ${clearedCount} players.`, clearedCount };
    } catch (error) {
        logger.error({ err: error, channel: lowerChannel }, `[GeoStorage-GCloud] Error clearing leaderboard data for channel ${lowerChannel}. Partial data may remain.`);
        return { success: false, message: `An error occurred while clearing leaderboard data. ${clearedCount} records might have been cleared before the error. Check logs.`, clearedCount };
    }
}

async function reportProblemLocation(locationName, reason, channelName) {
    const db = _getDb();
    const historyCollection = db.collection(HISTORY_COLLECTION);
    const lowerChannel = channelName.toLowerCase();
    const primaryLocationName = locationName.split('/')[0].trim(); // Ensure we use the primary name if alternates exist

    logger.info(`[GeoStorage-GCloud] Attempting to report problem for location "${primaryLocationName}" in channel ${lowerChannel}. Reason: ${reason}`);

    try {
        const querySnapshot = await historyCollection
            .where('channel', '==', lowerChannel)
            .where('location', '==', primaryLocationName)
            .orderBy('timestamp', 'desc')
            .limit(1)
            .get();

        if (querySnapshot.empty) {
            logger.warn(`[GeoStorage-GCloud] No game history found for location "${primaryLocationName}" in channel ${lowerChannel} to report.`);
            return { success: false, message: `Couldn't find a recent game record for "${primaryLocationName}" to report.` };
        }

        const docRef = querySnapshot.docs[0].ref;

        await docRef.update({
            flaggedAsProblem: true,
            problemReason: reason,
            flaggedTimestamp: FieldValue.serverTimestamp()
        });

        logger.info(`[GeoStorage-GCloud] Successfully flagged location "${primaryLocationName}" in channel ${lowerChannel}.`);
        return { success: true, message: `Successfully reported location "${primaryLocationName}".` };

    } catch (error) {
        logger.error({ err: error, location: primaryLocationName, channel: lowerChannel, reason }, `[GeoStorage-GCloud] Error reporting problem location.`);
        return { success: false, message: `An error occurred while reporting "${primaryLocationName}".` };
    }
}

/**
 * Gets the gameSessionId and item details of the most recently completed game session.
 * @param {string} channelName - The channel name (without #)
 * @returns {Promise<{gameSessionId: string | null, totalRounds: number, itemsInSession: Array<{docId: string, itemData: string, roundNumber: number}> }|null>}
 * itemData will be the location string for Geo.
 * Returns null if no history found or an error occurs.
 */
async function getLatestCompletedSessionInfo(channelName) {
    const db = _getDb();
    const historyCollection = db.collection(HISTORY_COLLECTION);
    const lowerChannelName = channelName.toLowerCase();

    try {
        logger.debug(`[GeoStorage-GCloud][${lowerChannelName}] Fetching latest game entry.`);
        const latestEntrySnapshot = await historyCollection
            .where('channel', '==', lowerChannelName)
            .orderBy('timestamp', 'desc')
            .limit(1)
            .get();

        if (latestEntrySnapshot.empty) {
            logger.debug(`[GeoStorage-GCloud][${lowerChannelName}] No game history found.`);
            return null;
        }

        const latestEntryDoc = latestEntrySnapshot.docs[0];
        const latestEntryData = latestEntryDoc.data();
        const gameSessionId = latestEntryData.gameSessionId || null;
        const totalRoundsInSession = latestEntryData.totalRounds || 1;
        const latestRoundNumber = latestEntryData.roundNumber || 1;

        logger.debug(`[GeoStorage-GCloud][${lowerChannelName}] Latest entry: ID=${latestEntryDoc.id}, SessionID=${gameSessionId}, TotalRounds=${totalRoundsInSession}, Location=${latestEntryData.location}`);

        // If it's a multi-round game and we have a session ID, fetch all rounds for that session
        if (gameSessionId && totalRoundsInSession > 1) {
            logger.debug(`[GeoStorage-GCloud][${lowerChannelName}] Multi-round session detected (ID: ${gameSessionId}). Fetching all locations for this session.`);
            const sessionItemsQuery = historyCollection
                .where('channel', '==', lowerChannelName)
                .where('gameSessionId', '==', gameSessionId)
                .orderBy('roundNumber', 'asc')
                .limit(totalRoundsInSession + 5);

            const sessionItemsSnapshot = await sessionItemsQuery.get();
            const itemsInSession = [];
            if (!sessionItemsSnapshot.empty) {
                sessionItemsSnapshot.forEach(doc => {
                    const data = doc.data();
                    if (data.gameSessionId === gameSessionId && data.location && typeof data.roundNumber === 'number') {
                        itemsInSession.push({
                            docId: doc.id,
                            itemData: data.location,
                            roundNumber: data.roundNumber
                        });
                    }
                });
            }

            if (itemsInSession.length > 0) {
                logger.info(`[GeoStorage-GCloud][${lowerChannelName}] Found ${itemsInSession.length} locations for session ID ${gameSessionId}.`);
                return { gameSessionId, totalRounds: totalRoundsInSession, itemsInSession };
            } else {
                logger.warn(`[GeoStorage-GCloud][${lowerChannelName}] Session query for ID ${gameSessionId} was empty. Falling back to latest entry.`);
                return {
                    gameSessionId,
                    totalRounds: 1,
                    itemsInSession: [{
                        docId: latestEntryDoc.id,
                        itemData: latestEntryData.location,
                        roundNumber: latestRoundNumber
                    }]
                };
            }
        } else {
            logger.debug(`[GeoStorage-GCloud][${lowerChannelName}] Single round game or no session ID on latest. Reporting only last location.`);
            return {
                gameSessionId,
                totalRounds: 1,
                itemsInSession: [{
                    docId: latestEntryDoc.id,
                    itemData: latestEntryData.location,
                    roundNumber: latestRoundNumber
                }]
            };
        }
    } catch (error) {
        logger.error({ err: error, channel: lowerChannelName }, `[GeoStorage-GCloud] Error fetching latest session info.`);
        if (error.code === 5 && error.message && error.message.includes('index')) {
            logger.warn(`[GeoStorage-GCloud] Firestore index likely missing for getLatestCompletedSessionInfo query. Please check Firestore console for index suggestions on collection '${HISTORY_COLLECTION}'. You might need composite indexes involving 'channel', 'timestamp', 'gameSessionId', and 'roundNumber'.`);
        }
        return null;
    }
}

/**
 * Flags a specific Geo-Game history document as problematic by its Firestore ID.
 * @param {string} docId - The Firestore document ID of the game history entry.
 * @param {string} reason - The reason for flagging.
 * @param {string} reportedByUsername - Username of the reporter.
 * @returns {Promise<void>}
 * @throws {StorageError} If updating fails.
 */
async function flagGeoLocationByDocId(docId, reason, reportedByUsername) {
    const db = _getDb();
    const docRef = db.collection(HISTORY_COLLECTION).doc(docId);
    logger.info(`[GeoStorage-GCloud] Flagging Geo-Game entry ${docId} as problematic. Reason: "${reason}", Reported by: ${reportedByUsername}`);
    try {
        await docRef.update({
            flaggedAsProblem: true,
            problemReason: reason,
            reportedBy: reportedByUsername.toLowerCase(),
            flaggedTimestamp: FieldValue.serverTimestamp()
        });
        logger.debug(`[GeoStorage-GCloud] Successfully flagged Geo-Game entry ${docId}.`);
    } catch (error) {
        logger.error({ err: error, docId, reason }, `[GeoStorage-GCloud] Error flagging Geo-Game entry ${docId}.`);
        throw new StorageError(`Failed to flag Geo-Game entry ${docId}`, error);
    }
}

export {
    initializeStorage,
    loadChannelConfig,
    saveChannelConfig,
    recordGameResult,
    updatePlayerScore,
    getPlayerStats,
    getLeaderboard,
    getRecentLocations,
    clearChannelLeaderboardData,
    reportProblemLocation,
    getLatestCompletedSessionInfo,
    flagGeoLocationByDocId
};