// src/lib/baseGameStorage.js
import { getFirestore, FieldValue } from './firestore.js';
import logger from './logger.js';

export class StorageError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'StorageError';
        this.cause = cause;
    }
}

export class BaseGameStorage {
    /**
     * @param {object} config
     * @param {string} config.gameName        - Display name for log messages (e.g. 'Trivia').
     * @param {string} config.configCollection  - Firestore collection for channel configs.
     * @param {string} config.statsCollection   - Firestore collection for player stats.
     * @param {string} config.historyCollection - Firestore collection for game history.
     */
    constructor({ gameName, configCollection, statsCollection, historyCollection }) {
        this.gameName = gameName;
        this.configCollection = configCollection;
        this.statsCollection = statsCollection;
        this.historyCollection = historyCollection;
    }

    _getDb() {
        return getFirestore();
    }

    _tag() {
        return `[${this.gameName}Storage]`;
    }

    // ── No-op initialization (Firestore is centrally initialized) ──────

    async initializeStorage() {
        logger.debug(`${this._tag()} Using shared Firestore client.`);
    }

    // ── Channel Configuration ──────────────────────────────────────────

    async loadChannelConfig(channelName) {
        const docRef = this._getDb().collection(this.configCollection).doc(channelName.toLowerCase());
        try {
            const docSnap = await docRef.get();
            if (docSnap.exists) {
                logger.debug(`${this._tag()} Loaded config for channel ${channelName}`);
                return docSnap.data();
            }
            logger.debug(`${this._tag()} No config found for channel ${channelName}`);
            return null;
        } catch (error) {
            logger.error({ err: error, channel: channelName }, `${this._tag()} Error loading config`);
            throw new StorageError(`Failed to load config for ${channelName}`, error);
        }
    }

    async saveChannelConfig(channelName, config) {
        const docRef = this._getDb().collection(this.configCollection).doc(channelName.toLowerCase());
        try {
            await docRef.set(config, { merge: true });
            logger.debug(`${this._tag()} Saved config for channel ${channelName}`);
        } catch (error) {
            logger.error({ err: error, channel: channelName }, `${this._tag()} Error saving config`);
            throw new StorageError(`Failed to save config for ${channelName}`, error);
        }
    }

    // ── Game History ───────────────────────────────────────────────────

    /**
     * Records a completed game result. Subclasses can override for custom
     * sanitization or additional side-effects (e.g. saving to a question bank).
     * @param {object} gameDetails
     */
    async recordGameResult(gameDetails) {
        const colRef = this._getDb().collection(this.historyCollection);
        try {
            const dataToSave = {
                ...gameDetails,
                channel: gameDetails.channel?.toLowerCase() || 'unknown',
                timestamp: FieldValue.serverTimestamp()
            };
            await colRef.add(dataToSave);
            logger.debug(`${this._tag()} Recorded game result for channel ${dataToSave.channel}`);
        } catch (error) {
            logger.error({ err: error, channel: gameDetails?.channel }, `${this._tag()} Error recording game result`);
            throw new StorageError('Failed to record game result', error);
        }
    }

    // ── Player Score ───────────────────────────────────────────────────

    /**
     * Atomically increments a player's score using canonical field names:
     *   globalSuccesses, globalPoints, globalParticipation, lastSuccessTimestamp
     *   channels.<ch>.successes, .points, .participation, .lastSuccessTimestamp
     */
    async updatePlayerScore(username, channelName, points = 1, displayName = null) {
        const lowerUsername = username.toLowerCase();
        const lowerChannel = channelName.toLowerCase();
        const docRef = this._getDb().collection(this.statsCollection).doc(lowerUsername);

        try {
            const updateData = {
                globalSuccesses: FieldValue.increment(points > 0 ? 1 : 0),
                globalPoints: FieldValue.increment(points),
                globalParticipation: FieldValue.increment(1),
                ...(points > 0 && { lastSuccessTimestamp: FieldValue.serverTimestamp() }),
                channels: {
                    [lowerChannel]: {
                        successes: FieldValue.increment(points > 0 ? 1 : 0),
                        points: FieldValue.increment(points),
                        participation: FieldValue.increment(1),
                        ...(points > 0 && { lastSuccessTimestamp: FieldValue.serverTimestamp() })
                    }
                }
            };

            if (displayName) updateData.displayName = displayName;

            await docRef.set(updateData, { merge: true });
            logger.debug(`${this._tag()} Updated stats for player ${lowerUsername} in channel ${lowerChannel} (+${points} points)`);
        } catch (error) {
            logger.error({ err: error, player: lowerUsername, channel: lowerChannel }, `${this._tag()} Error updating player score`);
            throw new StorageError(`Failed to update player score for ${lowerUsername} in ${lowerChannel}`, error);
        }
    }

    // ── Player Stats ───────────────────────────────────────────────────

    /**
     * Retrieves player statistics using canonical field names.
     * Subclasses can override to provide game-specific aliases.
     * @param {string} username
     * @param {string|null} channelName
     * @returns {Promise<object|null>}
     */
    async getPlayerStats(username, channelName = null) {
        const lowerUsername = username.toLowerCase();
        const docRef = this._getDb().collection(this.statsCollection).doc(lowerUsername);

        try {
            const docSnap = await docRef.get();
            if (!docSnap.exists) return null;

            const data = docSnap.data();
            const globalStats = {
                successes: data.globalSuccesses || 0,
                points: data.globalPoints || 0,
                participation: data.globalParticipation || 0,
                displayName: data.displayName || lowerUsername,
                lastSuccessTimestamp: data.lastSuccessTimestamp || null,
                channelsData: data.channels || {}
            };

            if (channelName) {
                const lowerChannel = channelName.toLowerCase();
                const channelData = data.channels?.[lowerChannel];
                const channelStats = channelData ? {
                    successes: channelData.successes || 0,
                    points: channelData.points || 0,
                    participation: channelData.participation || 0,
                    lastSuccessTimestamp: channelData.lastSuccessTimestamp || null
                } : { successes: 0, points: 0, participation: 0, lastSuccessTimestamp: null };

                return { ...globalStats, channelStats };
            }

            return globalStats;
        } catch (error) {
            logger.error({
                err: error,
                player: lowerUsername,
                channel: channelName
            }, `${this._tag()} Error getting player stats`);
            return null;
        }
    }

    // ── Leaderboard ────────────────────────────────────────────────────

    /**
     * Retrieves the top N players by points.
     * Returns a standardized shape:
     *   Channel: { id, data: { displayName, channelPoints, channelSuccesses, channelParticipation } }
     *   Global:  { id, data: { displayName, points, successes, participation } }
     */
    async getLeaderboard(channelName = null, limit = 10) {
        const db = this._getDb();
        const colRef = db.collection(this.statsCollection);
        const leaderboard = [];

        try {
            if (channelName) {
                const lowerChannel = channelName.toLowerCase();
                logger.debug(`${this._tag()} Retrieving channel-specific leaderboard for ${lowerChannel}`);

                let snapshot;
                const pointsFieldPath = `channels.${lowerChannel}.points`;

                try {
                    snapshot = await colRef
                        .orderBy(pointsFieldPath, 'desc')
                        .limit(limit)
                        .get();
                } catch (indexError) {
                    // Fallback: query by existence + manual sort if index is missing
                    logger.warn({ err: indexError, channel: lowerChannel }, `${this._tag()} Index likely missing for channel points sort. Falling back to manual sort.`);
                    const participationPath = `channels.${lowerChannel}.participation`;
                    const allSnapshot = await colRef
                        .where(participationPath, '>', 0)
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
                                    channelPoints: channelData.points || 0,
                                    channelSuccesses: channelData.successes || 0,
                                    channelParticipation: channelData.participation || 0,
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
                            channelPoints: channelData?.points || 0,
                            channelSuccesses: channelData?.successes || 0,
                            channelParticipation: channelData?.participation || 0,
                        }
                    });
                });
                logger.debug(`${this._tag()} Retrieved channel leaderboard with ${leaderboard.length} players for ${lowerChannel}.`);
                return leaderboard;

            } else {
                // Global leaderboard
                const snapshot = await colRef.orderBy('globalPoints', 'desc').limit(limit).get();
                snapshot.forEach(doc => {
                    const data = doc.data();
                    leaderboard.push({
                        id: doc.id,
                        data: {
                            displayName: data.displayName || doc.id,
                            points: data.globalPoints || 0,
                            successes: data.globalSuccesses || 0,
                            participation: data.globalParticipation || 0
                        }
                    });
                });
                logger.debug(`${this._tag()} Retrieved global leaderboard with ${leaderboard.length} players.`);
                return leaderboard;
            }
        } catch (error) {
            logger.error({
                err: error,
                channel: channelName || 'global'
            }, `${this._tag()} Error retrieving leaderboard.`);
            return [];
        }
    }

    // ── Clear Channel Leaderboard ──────────────────────────────────────

    /**
     * Deletes channel-specific stats for all players in a channel
     * by removing the `channels.<channel>` nested map in batches.
     */
    async clearChannelLeaderboardData(channelName) {
        const db = this._getDb();
        const lowerChannel = channelName.toLowerCase();
        const statsCol = db.collection(this.statsCollection);
        let clearedCount = 0;
        const batchSize = 100;

        logger.info(`${this._tag()} Starting leaderboard clear process for channel: ${lowerChannel}`);

        try {
            const fieldPath = `channels.${lowerChannel}`;
            let query = statsCol.where(fieldPath, '!=', null).limit(batchSize);
            let lastVisible;

            let hasMore = true;
            while (hasMore) {
                const snapshot = await query.get();
                if (snapshot.empty) {
                    hasMore = false;
                    break;
                }

                const batch = db.batch();
                snapshot.docs.forEach(doc => {
                    batch.update(doc.ref, { [`channels.${lowerChannel}`]: FieldValue.delete() });
                    clearedCount++;
                });

                await batch.commit();
                logger.debug(`${this._tag()} Cleared leaderboard data batch for ${snapshot.size} players. Total cleared: ${clearedCount}`);

                if (snapshot.size < batchSize) {
                    hasMore = false;
                    break;
                }

                lastVisible = snapshot.docs[snapshot.docs.length - 1];
                query = statsCol
                    .where(fieldPath, '!=', null)
                    .startAfter(lastVisible)
                    .limit(batchSize);

                await new Promise(resolve => setTimeout(resolve, 50));
            }

            logger.info(`${this._tag()} Successfully cleared leaderboard data for ${clearedCount} players in channel ${lowerChannel}.`);
            return {
                success: true,
                message: `Successfully cleared ${this.gameName.toLowerCase()} leaderboard data for ${clearedCount} players.`,
                clearedCount
            };
        } catch (error) {
            logger.error({ err: error, channel: lowerChannel }, `${this._tag()} Error clearing leaderboard data.`);
            return {
                success: false,
                message: `An error occurred while clearing leaderboard data. ${clearedCount} records might have been cleared before the error.`,
                clearedCount
            };
        }
    }

    // ── Latest Completed Session ───────────────────────────────────────

    /**
     * Gets the most recently completed game session for a channel.
     * Subclasses override `_extractItemData(docData)` to control
     * what `itemData` looks like per game type.
     *
     * @param {string} channelName
     * @returns {Promise<{gameSessionId: string|null, totalRounds: number, itemsInSession: Array}>|null}
     */
    async getLatestCompletedSessionInfo(channelName) {
        const db = this._getDb();
        const historyCol = db.collection(this.historyCollection);
        const lowerChannelName = channelName.toLowerCase();

        try {
            logger.debug(`${this._tag()}[${lowerChannelName}] Fetching latest game entry.`);
            const latestEntrySnapshot = await historyCol
                .where('channel', '==', lowerChannelName)
                .orderBy('timestamp', 'desc')
                .limit(1)
                .get();

            if (latestEntrySnapshot.empty) {
                logger.debug(`${this._tag()}[${lowerChannelName}] No game history found.`);
                return null;
            }

            const latestEntryDoc = latestEntrySnapshot.docs[0];
            const latestEntryData = latestEntryDoc.data();
            const gameSessionId = latestEntryData.gameSessionId || null;
            const totalRoundsInSession = latestEntryData.totalRounds || 1;
            const latestRoundNumber = latestEntryData.roundNumber || 1;

            logger.debug(`${this._tag()}[${lowerChannelName}] Latest entry: ID=${latestEntryDoc.id}, SessionID=${gameSessionId}, TotalRounds=${totalRoundsInSession}`);

            // If multi-round session, fetch all rounds
            if (gameSessionId && totalRoundsInSession > 1) {
                logger.debug(`${this._tag()}[${lowerChannelName}] Multi-round session detected (ID: ${gameSessionId}). Fetching all items.`);
                const sessionItemsQuery = historyCol
                    .where('channel', '==', lowerChannelName)
                    .where('gameSessionId', '==', gameSessionId)
                    .orderBy('roundNumber', 'asc')
                    .limit(totalRoundsInSession + 5);

                const sessionItemsSnapshot = await sessionItemsQuery.get();
                const itemsInSession = [];

                if (!sessionItemsSnapshot.empty) {
                    sessionItemsSnapshot.forEach(doc => {
                        const data = doc.data();
                        if (data.gameSessionId === gameSessionId && typeof data.roundNumber === 'number') {
                            const itemData = this._extractItemData(data);
                            if (itemData !== null) {
                                itemsInSession.push({
                                    docId: doc.id,
                                    itemData,
                                    roundNumber: data.roundNumber
                                });
                            }
                        }
                    });
                }

                if (itemsInSession.length > 0) {
                    logger.info(`${this._tag()}[${lowerChannelName}] Found ${itemsInSession.length} items for session ID ${gameSessionId}.`);
                    return { gameSessionId, totalRounds: totalRoundsInSession, itemsInSession };
                } else {
                    logger.warn(`${this._tag()}[${lowerChannelName}] Session query for ID ${gameSessionId} was empty. Falling back to latest entry.`);
                }
            }

            // Single round or fallback
            logger.debug(`${this._tag()}[${lowerChannelName}] Reporting single item from latest entry.`);
            const singleItemData = this._extractItemData(latestEntryData);
            if (singleItemData === null) {
                logger.warn(`${this._tag()}[${lowerChannelName}] Single-round fallback: _extractItemData returned null for doc ${latestEntryDoc.id}. Returning null.`);
                return null;
            }
            return {
                gameSessionId,
                totalRounds: 1,
                itemsInSession: [{
                    docId: latestEntryDoc.id,
                    itemData: singleItemData,
                    roundNumber: latestRoundNumber
                }]
            };
        } catch (error) {
            logger.error({ err: error, channel: lowerChannelName }, `${this._tag()} Error fetching latest session info.`);
            if (error.code === 5 && error.message?.includes('index')) {
                logger.warn(`${this._tag()} Firestore index likely missing for getLatestCompletedSessionInfo query on collection '${this.historyCollection}'.`);
            }
            return null;
        }
    }

    /**
     * Extracts game-specific item data from a history document.
     * Override in subclasses.
     * @param {object} docData - The raw Firestore document data.
     * @returns {*} The extracted item data.
     */
    _extractItemData(docData) {
        return docData;
    }

    // ── Flag History Entry ─────────────────────────────────────────────

    /**
     * Flags a specific game history document as problematic by its Firestore ID.
     */
    async flagHistoryEntryByDocId(docId, reason, reportedByUsername) {
        const docRef = this._getDb().collection(this.historyCollection).doc(docId);
        logger.info(`${this._tag()} Flagging entry ${docId} as problematic. Reason: "${reason}", Reported by: ${reportedByUsername}`);
        try {
            await docRef.update({
                flaggedAsProblem: true,
                problemReason: reason,
                reportedBy: reportedByUsername.toLowerCase(),
                flaggedTimestamp: FieldValue.serverTimestamp()
            });
            logger.debug(`${this._tag()} Successfully flagged entry ${docId}.`);
        } catch (error) {
            logger.error({ err: error, docId, reason }, `${this._tag()} Error flagging entry ${docId}.`);
            throw new StorageError(`Failed to flag entry ${docId}`, error);
        }
    }
}