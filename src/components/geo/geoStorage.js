// src/components/geo/geoStorage.js
import { FieldValue } from '../../lib/firestore.js';
import { BaseGameStorage, StorageError } from '../../lib/baseGameStorage.js';
import logger from '../../lib/logger.js';

// Collection names
const CONFIG_COLLECTION = 'geoGameConfigs';
const STATS_COLLECTION = 'geoPlayerStats';
const HISTORY_COLLECTION = 'geoGameHistory';

// ── Geo-specific storage that extends the shared base ─────────────

class GeoStorage extends BaseGameStorage {
    constructor() {
        super({
            gameName: 'Geo',
            configCollection: CONFIG_COLLECTION,
            statsCollection: STATS_COLLECTION,
            historyCollection: HISTORY_COLLECTION,
        });
    }

    /**
     * For getLatestCompletedSessionInfo: extract location string from history doc.
     */
    _extractItemData(data) {
        return data.location || null;
    }

    /**
     * Retrieves player stats with geo-specific backward-compatible aliases.
     */
    async getPlayerStats(username, channelName = null) {
        const lowerUsername = username.toLowerCase();
        const docRef = this._getDb().collection(this.statsCollection).doc(lowerUsername);

        try {
            const docSnap = await docRef.get();
            if (docSnap.exists) {
                const data = docSnap.data();
                const globalStats = {
                    points: data.globalPoints ?? data.globalSuccesses ?? 0,
                    wins: data.globalSuccesses ?? data.globalWins ?? 0,
                    participation: data.globalParticipation ?? 0,
                    displayName: data.displayName || lowerUsername,
                    lastWinTimestamp: data.lastSuccessTimestamp || data.lastWinTimestamp || null,
                    channelsData: data.channels || {}
                };

                if (channelName) {
                    const lowerChannel = channelName.toLowerCase();
                    const channelData = data.channels?.[lowerChannel];
                    const channelStats = channelData ? {
                        points: channelData.points ?? channelData.successes ?? 0,
                        wins: channelData.successes ?? channelData.wins ?? 0,
                        participation: channelData.participation ?? 0,
                        lastWinTimestamp: channelData.lastSuccessTimestamp || channelData.lastWinTimestamp || null
                    } : { points: 0, wins: 0, participation: 0, lastWinTimestamp: null };

                    return {
                        ...globalStats,
                        channelStats,
                    };
                }

                return globalStats;
            } else {
                return null;
            }
        } catch (error) {
            logger.error({
                err: error,
                player: lowerUsername,
                channel: channelName
            }, `[GeoStorage] Error getting player stats for ${lowerUsername}`);
            throw new StorageError(`Failed to get player stats for ${lowerUsername}`, error);
        }
    }

    // ── Geo-specific methods ───────────────────────────────────────────

    /**
     * Retrieves a list of recently played target locations for a channel.
     */
    async getRecentLocations(channelName, limit = 10) {
        const db = this._getDb();
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
                    }, `[GeoStorage] Firestore index not created yet for channel+timestamp query. Using fallback query.`);
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
            logger.debug(`[GeoStorage] Found ${recentLocations.length} recent locations for channel ${lowerChannelName}.`);
            return recentLocations;
        } catch (error) {
            logger.error({ err: error, channel: lowerChannelName }, `[GeoStorage] Error getting recent locations for channel ${lowerChannelName}`);
            throw new StorageError(`Failed to get recent locations for ${lowerChannelName}`, error);
        }
    }

    /**
     * Reports a problem with a specific location by finding and flagging it in history.
     */
    async reportProblemLocation(locationName, reason, channelName, reportedByUsername = null) {
        const db = this._getDb();
        const historyCol = db.collection(HISTORY_COLLECTION);
        const lowerChannel = channelName.toLowerCase();
        const primaryLocationName = locationName.split('/')[0].trim();

        logger.info(`[GeoStorage] Attempting to report problem for location "${primaryLocationName}" in channel ${lowerChannel}. Reason: ${reason}`);

        try {
            const querySnapshot = await historyCol
                .where('channel', '==', lowerChannel)
                .where('location', '==', primaryLocationName)
                .orderBy('timestamp', 'desc')
                .limit(1)
                .get();

            if (querySnapshot.empty) {
                logger.warn(`[GeoStorage] No game history found for location "${primaryLocationName}" in channel ${lowerChannel} to report.`);
                return { success: false, message: `Couldn't find a recent game record for "${primaryLocationName}" to report.` };
            }

            const docRef = querySnapshot.docs[0].ref;
            const updateData = {
                flaggedAsProblem: true,
                problemReason: reason,
                flaggedTimestamp: FieldValue.serverTimestamp()
            };
            if (reportedByUsername) {
                updateData.reportedBy = reportedByUsername.toLowerCase();
            }
            await docRef.update(updateData);

            logger.info(`[GeoStorage] Successfully flagged location "${primaryLocationName}" in channel ${lowerChannel}.`);
            return { success: true, message: `Successfully reported location "${primaryLocationName}".` };

        } catch (error) {
            logger.error({ err: error, location: primaryLocationName, channel: lowerChannel, reason }, `[GeoStorage] Error reporting problem location.`);
            return { success: false, message: `An error occurred while reporting "${primaryLocationName}".` };
        }
    }
}

// ── Singleton instance ─────────────────────────────────────────────

const geoStorage = new GeoStorage();

// ── Backward-compatible named exports ──────────────────────────────

const initializeStorage = () => geoStorage.initializeStorage();
const loadChannelConfig = (channelName) => geoStorage.loadChannelConfig(channelName);
const saveChannelConfig = (channelName, config) => geoStorage.saveChannelConfig(channelName, config);
const recordGameResult = (gameDetails) => geoStorage.recordGameResult(gameDetails);
const updatePlayerScore = (username, channelName, points, displayName) => geoStorage.updatePlayerScore(username, channelName, points, displayName);
const getPlayerStats = (username, channelName) => geoStorage.getPlayerStats(username, channelName);
const getLeaderboard = (channelName, limit) => geoStorage.getLeaderboard(channelName, limit);
const getRecentLocations = (channelName, limit) => geoStorage.getRecentLocations(channelName, limit);
const clearChannelLeaderboardData = (channelName) => geoStorage.clearChannelLeaderboardData(channelName);
const reportProblemLocation = (locationName, reason, channelName, reportedByUsername) => geoStorage.reportProblemLocation(locationName, reason, channelName, reportedByUsername);
const getLatestCompletedSessionInfo = (channelName) => geoStorage.getLatestCompletedSessionInfo(channelName);
const flagGeoLocationByDocId = (docId, reason, reportedByUsername) => geoStorage.flagHistoryEntryByDocId(docId, reason, reportedByUsername);

export {
    initializeStorage,
    StorageError,
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