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
 * Initializes the Google Cloud Firestore client.
 * Relies on Application Default Credentials or GOOGLE_APPLICATION_CREDENTIALS environment variable.
 */
export async function initializeStorage() {
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
export async function loadChannelConfig(channelName) {
    const db = _getDb();
    const docRef = db.collection(CONFIG_COLLECTION).doc(channelName.toLowerCase());
    try {
        const docSnap = await docRef.get();
        if (docSnap.exists) {
            logger.debug(`[GeoStorage-GCloud] Loaded config for channel ${channelName}`);
            return docSnap.data();
        } else {
            logger.debug(`[GeoStorage-GCloud] No config found for channel ${channelName}`);
            return null; // No config document exists for this channel
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `[GeoStorage-GCloud] Error loading config for channel ${channelName}`);
        return null; // Return null on error
    }
}

/**
 * Saves or updates the configuration for a specific channel in Firestore.
 * @param {string} channelName
 * @param {object} config - The complete config object to save.
 * @returns {Promise<boolean>} True on success, false on failure.
 */
export async function saveChannelConfig(channelName, config) {
    const db = _getDb();
    const docRef = db.collection(CONFIG_COLLECTION).doc(channelName.toLowerCase());
    try {
        // Using set with merge: true allows partial updates if needed later
        await docRef.set(config, { merge: true });
        logger.debug(`[GeoStorage-GCloud] Saved config for channel ${channelName}`);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `[GeoStorage-GCloud] Error saving config for channel ${channelName}`);
        return false;
    }
}

/**
 * Records the result of a completed game in Firestore.
 * @param {object} gameResultDetails - Details like winner, location, duration, channel etc.
 * @returns {Promise<boolean>} True on success, false on failure.
 */
export async function recordGameResult(gameResultDetails) {
    const db = _getDb();
    const colRef = db.collection(HISTORY_COLLECTION);
    try {
        // Add server timestamp for reliable ordering/querying
        const dataToSave = {
            ...gameResultDetails,
            timestamp: FieldValue.serverTimestamp()
        };
        await colRef.add(dataToSave);
        logger.debug(`[GeoStorage-GCloud] Recorded game result.`);
        return true;
    } catch (error) {
        logger.error({ err: error }, `[GeoStorage-GCloud] Error recording game result.`);
        return false;
    }
}

/**
 * Updates player scores/stats using Firestore atomic increments.
 * @param {string} username - Lowercase username.
 * @param {number} points - Points to add for a win (typically 1).
 * @param {string} [displayName] - Optional display name to store with the player record.
 * @returns {Promise<boolean>} True on success, false on failure.
 */
export async function updatePlayerScore(username, points = 1, displayName = null) {
    const db = _getDb();
    const docRef = db.collection(STATS_COLLECTION).doc(username.toLowerCase());
    try {
        // Prepare update data with atomic increments
        const updateData = {
            wins: FieldValue.increment(points),
            participation: FieldValue.increment(1),
            lastWinTimestamp: FieldValue.serverTimestamp()
        };
        
        // Add display name if provided
        if (displayName) {
            updateData.displayName = displayName;
        }
        
        // Use set with merge for atomic updates
        await docRef.set(updateData, { merge: true });

        logger.debug(`[GeoStorage-GCloud] Updated stats for player ${username}`);
        return true;
    } catch (error) {
        logger.error({ err: error, player: username }, `[GeoStorage-GCloud] Error updating player score for ${username}`);
        return false;
    }
}

/**
 * Retrieves stats for a specific player.
 * @param {string} username - Lowercase username.
 * @returns {Promise<object|null>} Player stats object or null if not found/error.
 */
export async function getPlayerStats(username) {
    const db = _getDb();
    const docRef = db.collection(STATS_COLLECTION).doc(username.toLowerCase());
     try {
        const docSnap = await docRef.get();
        if (docSnap.exists) {
            return docSnap.data();
        } else {
            return null; // Player has no stats yet
        }
    } catch (error) {
        logger.error({ err: error, player: username }, `[GeoStorage-GCloud] Error getting player stats for ${username}`);
        return null;
    }
}

/**
 * Retrieves the top N players based on wins.
 * @param {number} [limit=10] - Number of top players to retrieve.
 * @returns {Promise<Array<{id: string, data: object}>>} Array of player objects {id: username, data: {wins, participation, ...}}.
 */
export async function getLeaderboard(limit = 10) {
    const db = _getDb();
    const colRef = db.collection(STATS_COLLECTION);
    const leaderboard = [];
    try {
        const snapshot = await colRef.orderBy('wins', 'desc').limit(limit).get();
        snapshot.forEach(doc => {
            leaderboard.push({ id: doc.id, data: doc.data() });
        });
        logger.debug(`[GeoStorage-GCloud] Retrieved leaderboard with ${leaderboard.length} players.`);
    } catch (error) {
         logger.error({ err: error }, `[GeoStorage-GCloud] Error retrieving leaderboard.`);
    }
    return leaderboard;
}

/**
 * Retrieves a list of recently played target locations for a channel.
 * @param {string} channelName - Lowercase channel name.
 * @param {number} [limit=10] - How many recent locations to retrieve.
 * @returns {Promise<string[]>} An array of recent location names.
 */
export async function getRecentLocations(channelName, limit = 10) {
    const db = _getDb();
    const colRef = db.collection(HISTORY_COLLECTION);
    const lowerChannelName = channelName.toLowerCase();
    try {
        const snapshot = await colRef
            .where('channel', '==', lowerChannelName)
            .orderBy('timestamp', 'desc')
            .limit(limit)
            .get();
        const recentLocations = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.location) {
                // Extract the primary name if it includes alternates (e.g., "Kyoto / Kyo")
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
        return [];
    }
}