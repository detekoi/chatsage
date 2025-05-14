// src/components/riddle/riddleStorage.js
import { Firestore, FieldValue, Timestamp } from '@google-cloud/firestore';
import logger from '../../lib/logger.js';

// --- Firestore Collections ---
const RIDDLE_CONFIG_COLLECTION = 'riddleGameConfigs';
const RIDDLE_PLAYER_STATS_COLLECTION = 'riddlePlayerStats';
const RIDDLE_GAME_HISTORY_COLLECTION = 'riddleGameHistory';
const RIDDLE_RECENT_KEYWORDS_COLLECTION = 'riddleRecentKeywords'; // For storing keywords of recently asked riddles

let db = null;

export class RiddleStorageError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'RiddleStorageError';
        this.cause = cause;
    }
}

/**
 * Initializes the Firestore client for the riddle game.
 */
export async function initializeRiddleStorage() {
    logger.info("[RiddleStorage] Initializing Firestore client for Riddle Game...");
    try {
        if (!db) {
            db = new Firestore();
            // Test connection
            const testQuery = db.collection(RIDDLE_CONFIG_COLLECTION).limit(1);
            await testQuery.get();
            logger.info("[RiddleStorage] Firestore client initialized and connected successfully.");
        } else {
            logger.info("[RiddleStorage] Firestore client already initialized.");
        }
    } catch (error) {
        logger.fatal({ err: error }, "[RiddleStorage] CRITICAL: Failed to initialize Firestore client.");
        throw new RiddleStorageError("Failed to initialize RiddleStorage", error);
    }
}

function _getDb() {
    if (!db) {
        throw new RiddleStorageError("RiddleStorage not initialized. Call initializeRiddleStorage first.");
    }
    return db;
}

// --- Configuration Storage (Similar to Trivia/Geo) ---
export async function loadChannelRiddleConfig(channelName) {
    const firestore = _getDb();
    const docRef = firestore.collection(RIDDLE_CONFIG_COLLECTION).doc(channelName.toLowerCase());
    try {
        const docSnap = await docRef.get();
        if (docSnap.exists) {
            logger.debug(`[RiddleStorage] Loaded riddle config for channel ${channelName}`);
            return docSnap.data();
        }
        logger.debug(`[RiddleStorage] No riddle config found for channel ${channelName}, default will be used.`);
        return null;
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `[RiddleStorage] Error loading riddle config for ${channelName}`);
        throw new RiddleStorageError(`Failed to load riddle config for ${channelName}`, error);
    }
}

export async function saveChannelRiddleConfig(channelName, config) {
    const firestore = _getDb();
    const docRef = firestore.collection(RIDDLE_CONFIG_COLLECTION).doc(channelName.toLowerCase());
    try {
        await docRef.set(config, { merge: true });
        logger.debug(`[RiddleStorage] Saved riddle config for channel ${channelName}`);
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `[RiddleStorage] Error saving riddle config for ${channelName}`);
        throw new RiddleStorageError(`Failed to save riddle config for ${channelName}`, error);
    }
}

// --- Player Stats Storage ---
export async function updatePlayerScore(username, channelName, points, displayName) {
    const firestore = _getDb();
    const lowerUsername = username.toLowerCase();
    const lowerChannel = channelName.toLowerCase();
    const docRef = firestore.collection(RIDDLE_PLAYER_STATS_COLLECTION).doc(lowerUsername);

    try {
        const updateData = {
            globalCorrectAnswers: FieldValue.increment(1),
            globalPoints: FieldValue.increment(points),
            globalGamesPlayed: FieldValue.increment(1), // Or track participations differently
            lastCorrectTimestamp: FieldValue.serverTimestamp(),
            channels: {
                [lowerChannel]: {
                    correctAnswers: FieldValue.increment(1),
                    points: FieldValue.increment(points),
                    gamesPlayed: FieldValue.increment(1),
                    lastCorrectTimestamp: FieldValue.serverTimestamp()
                }
            }
        };
        if (displayName) {
            updateData.displayName = displayName;
        }
        await docRef.set(updateData, { merge: true });
        logger.debug(`[RiddleStorage] Updated score for player ${lowerUsername} in channel ${lowerChannel} (+${points} pts)`);
    } catch (error) {
        logger.error({ err: error, player: lowerUsername, channel: lowerChannel }, `[RiddleStorage] Error updating player score`);
        throw new RiddleStorageError(`Failed to update player score for ${lowerUsername} in ${lowerChannel}`, error);
    }
}

export async function getLeaderboard(channelName, limit = 10) {
    const firestore = _getDb();
    const statsCollection = firestore.collection(RIDDLE_PLAYER_STATS_COLLECTION);
    const leaderboard = [];

    try {
        let query;
        if (channelName) {
            const lowerChannel = channelName.toLowerCase();
            const fieldPath = `channels.${lowerChannel}.points`;
            query = statsCollection.orderBy(fieldPath, 'desc').limit(limit);
            logger.debug(`[RiddleStorage] Retrieving channel-specific riddle leaderboard for ${lowerChannel}`);
        } else {
            query = statsCollection.orderBy('globalPoints', 'desc').limit(limit);
            logger.debug(`[RiddleStorage] Retrieving global riddle leaderboard`);
        }

        const snapshot = await query.get();
        snapshot.forEach(doc => {
            const data = doc.data();
            const id = doc.id;
            if (channelName) {
                const channelData = data.channels?.[channelName.toLowerCase()];
                leaderboard.push({
                    id,
                    data: {
                        displayName: data.displayName || id,
                        points: channelData?.points || 0,
                        correctAnswers: channelData?.correctAnswers || 0,
                    }
                });
            } else {
                leaderboard.push({
                    id,
                    data: {
                        displayName: data.displayName || id,
                        points: data.globalPoints || 0,
                        correctAnswers: data.globalCorrectAnswers || 0,
                    }
                });
            }
        });
        logger.debug(`[RiddleStorage] Retrieved riddle leaderboard with ${leaderboard.length} players.`);
        return leaderboard;
    } catch (error) {
        // Handle specific "index missing" error for channel-specific leaderboards
        if (channelName && error.code === 5 && error.message.includes('index')) {
            logger.warn({ err: error, channel: channelName }, `[RiddleStorage] Firestore index likely missing for riddle channel leaderboard. Trying manual sort. Error: ${error.message}`);
            // Fallback to fetching more and sorting manually
            const allSnapshot = await statsCollection.where(`channels.${channelName.toLowerCase()}.points`, '>', -Infinity) // Fetch all with points for channel
                                                   .limit(limit * 5) // Fetch more to sort
                                                   .get();
            const players = [];
            allSnapshot.forEach(doc => {
                const data = doc.data();
                const channelData = data.channels?.[channelName.toLowerCase()];
                if (channelData && (typeof channelData.points === 'number')) {
                    players.push({
                        id: doc.id,
                        data: {
                            displayName: data.displayName || doc.id,
                            points: channelData.points,
                            correctAnswers: channelData.correctAnswers || 0,
                        }
                    });
                }
            });
            players.sort((a, b) => b.data.points - a.data.points);
            return players.slice(0, limit);
        }
        logger.error({ err: error, channel: channelName || 'global' }, `[RiddleStorage] Error retrieving riddle leaderboard.`);
        throw new RiddleStorageError(`Failed to retrieve riddle leaderboard for ${channelName || 'global'}`, error);
    }
}


export async function clearLeaderboardData(channelName) {
    const firestore = _getDb();
    const lowerChannel = channelName.toLowerCase();
    const statsCollection = firestore.collection(RIDDLE_PLAYER_STATS_COLLECTION);
    let clearedCount = 0;
    const batchSize = 100;
    logger.info(`[RiddleStorage] Starting riddle leaderboard clear for channel: ${lowerChannel}`);

    try {
        const fieldPath = `channels.${lowerChannel}`;
        let query = statsCollection.where(fieldPath, '!=', null).limit(batchSize);
        
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const snapshot = await query.get();
            if (snapshot.empty) break;

            const batch = firestore.batch();
            snapshot.docs.forEach(doc => {
                batch.update(doc.ref, { [fieldPath]: FieldValue.delete() });
                clearedCount++;
            });
            await batch.commit();
            logger.debug(`[RiddleStorage] Cleared riddle data batch for ${snapshot.size} players. Total: ${clearedCount}`);
            if (snapshot.size < batchSize) break;
            query = query.startAfter(snapshot.docs[snapshot.docs.length - 1]);
        }
        logger.info(`[RiddleStorage] Successfully cleared riddle leaderboard for ${clearedCount} players in ${lowerChannel}.`);
        return { success: true, message: `Riddle leaderboard cleared for ${clearedCount} players.`, clearedCount };
    } catch (error) {
        logger.error({ err: error, channel: lowerChannel }, `[RiddleStorage] Error clearing riddle leaderboard.`);
        throw new RiddleStorageError(`Failed to clear riddle leaderboard for ${lowerChannel}`, error);
    }
}

// --- Game History ---
export async function recordRiddleResult(details) {
    const firestore = _getDb();
    const historyCollection = firestore.collection(RIDDLE_GAME_HISTORY_COLLECTION);
    const dataToSave = {
        ...details, // channel, riddleText, riddleAnswer, winnerUsername, winnerDisplayName, topic, difficulty, keywords, etc.
        timestamp: FieldValue.serverTimestamp(),
    };
    try {
        await historyCollection.add(dataToSave);
        logger.debug(`[RiddleStorage] Recorded riddle game result for channel ${details.channelName}`);
    } catch (error) {
        logger.error({ err: error, details }, `[RiddleStorage] Error recording riddle game result`);
        throw new RiddleStorageError('Failed to record riddle game result', error);
    }
}

// --- Recent Riddle Keywords ---
const RECENT_KEYWORDS_TTL_DAYS = 7; // Keywords older than this might be pruned or ignored

export async function saveRiddleKeywords(channelName, keywords) {
    if (!keywords || keywords.length === 0) {
        logger.warn(`[RiddleStorage] Attempted to save empty keywords for channel ${channelName}. Skipping.`);
        return;
    }
    const firestore = _getDb();
    const keywordsCollection = firestore.collection(RIDDLE_RECENT_KEYWORDS_COLLECTION);
    const dataToSave = {
        channelName: channelName.toLowerCase(),
        keywords: keywords, // Array of strings
        createdAt: FieldValue.serverTimestamp()
    };
    try {
        await keywordsCollection.add(dataToSave);
        logger.debug(`[RiddleStorage] Saved riddle keywords for channel ${channelName}: ${keywords.join(', ')}`);
    } catch (error) {
        logger.error({ err: error, channel: channelName, keywords }, `[RiddleStorage] Error saving riddle keywords`);
        throw new RiddleStorageError('Failed to save riddle keywords', error);
    }
}

export async function getRecentKeywords(channelName, limit = 50) {
    const firestore = _getDb();
    const keywordsCollection = firestore.collection(RIDDLE_RECENT_KEYWORDS_COLLECTION);
    const recentKeywordSets = [];
    
    // Calculate cutoff date for TTL (optional, can also be done via Firestore TTL policy)
    // const cutoffDate = new Date(Date.now() - RECENT_KEYWORDS_TTL_DAYS * 24 * 60 * 60 * 1000);

    try {
        const query = keywordsCollection
            .where('channelName', '==', channelName.toLowerCase())
            // .where('createdAt', '>=', Timestamp.fromDate(cutoffDate)) // Optional: Filter by TTL here
            .orderBy('createdAt', 'desc')
            .limit(limit);

        const snapshot = await query.get();
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.keywords && Array.isArray(data.keywords)) {
                recentKeywordSets.push(data.keywords);
            }
        });
        logger.debug(`[RiddleStorage] Retrieved ${recentKeywordSets.length} recent keyword sets for channel ${channelName}.`);
        return recentKeywordSets;
    } catch (error) {
         if (error.code === 5 && error.message.includes('index')) { // Firestore 'Failed Precondition' for missing index
            logger.warn({ channel: channelName, error: error.message }, `[RiddleStorage] Firestore index likely missing for getRecentKeywords query. Please create a composite index on 'channelName' (asc) and 'createdAt' (desc) for the '${RIDDLE_RECENT_KEYWORDS_COLLECTION}' collection.`);
            // Attempt to query without orderBy if index is missing, though this is less ideal for "recent"
             const fallbackQuery = keywordsCollection
                .where('channelName', '==', channelName.toLowerCase())
                .limit(limit);
            try {
                const fallbackSnapshot = await fallbackQuery.get();
                 fallbackSnapshot.forEach(doc => {
                    const data = doc.data();
                    if (data.keywords && Array.isArray(data.keywords)) {
                        recentKeywordSets.push(data.keywords);
                    }
                });
                logger.debug(`[RiddleStorage] Retrieved ${recentKeywordSets.length} keyword sets (fallback query) for channel ${channelName}.`);
                return recentKeywordSets;
            } catch (fallbackError) {
                 logger.error({ err: fallbackError, channel: channelName }, `[RiddleStorage] Error with fallback query for recent keywords.`);
                 throw new RiddleStorageError(`Failed to get recent keywords for ${channelName} (fallback error)`, fallbackError);
            }

        }
        logger.error({ err: error, channel: channelName }, `[RiddleStorage] Error getting recent keywords`);
        throw new RiddleStorageError(`Failed to get recent keywords for ${channelName}`, error);
    }
}

/**
 * Optional: Prunes old keywords from the RIDDLE_RECENT_KEYWORDS_COLLECTION.
 * This can also be handled by Firestore's TTL policies for better efficiency.
 */
export async function pruneOldKeywords(channelName) {
    const firestore = _getDb();
    const keywordsCollection = firestore.collection(RIDDLE_RECENT_KEYWORDS_COLLECTION);
    const cutoffDate = Timestamp.fromDate(new Date(Date.now() - RECENT_KEYWORDS_TTL_DAYS * 24 * 60 * 60 * 1000));
    let deletedCount = 0;

    try {
        const snapshot = await keywordsCollection
            .where('channelName', '==', channelName.toLowerCase())
            .where('createdAt', '<', cutoffDate)
            .limit(500) // Process in batches
            .get();

        if (snapshot.empty) {
            logger.debug(`[RiddleStorage] No old keywords to prune for channel ${channelName}.`);
            return 0;
        }

        const batch = firestore.batch();
        snapshot.docs.forEach(doc => {
            batch.delete(doc.ref);
            deletedCount++;
        });
        await batch.commit();
        logger.info(`[RiddleStorage] Pruned ${deletedCount} old keyword sets for channel ${channelName}.`);
        return deletedCount;
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `[RiddleStorage] Error pruning old keywords.`);
        throw new RiddleStorageError(`Failed to prune old keywords for ${channelName}`, error);
    }
}

/**
 * Retrieves the most recent riddle played in a channel from the history.
 * @param {string} channelName - The name of the channel (without #).
 * @returns {Promise<{docId: string, question: string, answer: string, topic: string, keywords: string[]}|null>} Details of the last riddle or null.
 */
export async function getMostRecentRiddlePlayed(channelName) {
    const firestore = _getDb();
    const historyCollection = firestore.collection(RIDDLE_GAME_HISTORY_COLLECTION);
    const lowerChannelName = channelName.toLowerCase();

    logger.debug(`[RiddleStorage] Fetching most recent riddle for channel ${lowerChannelName}`);
    try {
        const snapshot = await historyCollection
            .where('channelName', '==', lowerChannelName)
            .orderBy('timestamp', 'desc')
            .limit(1)
            .get();

        if (snapshot.empty) {
            logger.debug(`[RiddleStorage] No riddle history found for channel ${lowerChannelName}.`);
            return null;
        }

        const doc = snapshot.docs[0];
        const data = doc.data();
        return {
            docId: doc.id,
            question: data.riddleText, // Assuming 'riddleText' was used in recordRiddleResult
            answer: data.riddleAnswer, // Assuming 'riddleAnswer' was used
            topic: data.topic,
            keywords: data.keywords || []
        };
    } catch (error) {
        logger.error({ err: error, channel: lowerChannelName }, `[RiddleStorage] Error fetching most recent riddle for ${lowerChannelName}`);
        // Check for missing index error
        if (error.code === 5 && error.message && error.message.includes('index')) {
            logger.warn(`[RiddleStorage] Firestore index likely missing for getMostRecentRiddlePlayed query on '${RIDDLE_GAME_HISTORY_COLLECTION}'. Needs index on 'channelName' (asc) and 'timestamp' (desc).`);
        }
        throw new RiddleStorageError(`Failed to get most recent riddle for ${lowerChannelName}`, error);
    }
}

/**
 * Flags a specific riddle in the game history as problematic.
 * @param {string} riddleDocId - The Firestore document ID of the riddle in riddleGameHistory.
 * @param {string} reason - The reason for flagging.
 * @param {string} reportedBy - The username of the person who reported it.
 * @returns {Promise<void>}
 */
export async function flagRiddleAsProblem(riddleDocId, reason, reportedBy) {
    const firestore = _getDb();
    const docRef = firestore.collection(RIDDLE_GAME_HISTORY_COLLECTION).doc(riddleDocId);

    logger.info(`[RiddleStorage] Flagging riddle ${riddleDocId} as problematic. Reason: ${reason}, Reported by: ${reportedBy}`);
    try {
        await docRef.update({
            flaggedAsProblem: true,
            problemReason: reason,
            reportedBy: reportedBy.toLowerCase(),
            flaggedTimestamp: FieldValue.serverTimestamp()
        });
        logger.debug(`[RiddleStorage] Successfully flagged riddle ${riddleDocId}.`);
    } catch (error) {
        logger.error({ err: error, riddleDocId, reason }, `[RiddleStorage] Error flagging riddle ${riddleDocId} as problematic.`);
        throw new RiddleStorageError(`Failed to flag riddle ${riddleDocId}`, error);
    }
}

const MAX_RECORDS_FOR_SESSION_LOOKUP = 20; // How far back to look for a session ID

/**
 * Gets the gameSessionId and totalRounds of the most recently completed game session.
 * @param {string} channelName
 * @returns {Promise<{gameSessionId: string, totalRounds: number, riddlesInSession: Array<{docId: string, question: string, answer: string, roundNumber: number}> }|null>}
 */
export async function getLatestCompletedSessionInfo(channelName) {
    const firestore = _getDb();
    const historyCollection = firestore.collection(RIDDLE_GAME_HISTORY_COLLECTION);
    const lowerChannelName = channelName.toLowerCase();

    try {
        logger.debug(`[RiddleStorage][${lowerChannelName}] --- Entering getLatestCompletedSessionInfo ---`); // Entry log
        const latestEntrySnapshot = await historyCollection
            .where('channelName', '==', lowerChannelName)
            .orderBy('timestamp', 'desc')
            .limit(1)
            .get();

        if (latestEntrySnapshot.empty) {
            logger.debug(`[RiddleStorage][${lowerChannelName}] No riddle history found. Returning null.`);
            return null;
        }

        const latestEntryDocId = latestEntrySnapshot.docs[0].id;
        const latestEntryData = latestEntrySnapshot.docs[0].data();
        const sessionId = latestEntryData.gameSessionId;
        const totalRoundsInSession = latestEntryData.totalRounds;

        logger.debug(`[RiddleStorage][${lowerChannelName}] Latest entry (Doc ID: ${latestEntryDocId}) for session check: sessionId=${sessionId}, totalRoundsInSession=${totalRoundsInSession}, riddleText="${latestEntryData.riddleText?.substring(0,30)}..."`);

        if (!sessionId || typeof totalRoundsInSession !== 'number') {
            logger.warn(`[RiddleStorage][${lowerChannelName}] Latest entry (ID: ${latestEntryDocId}) missing gameSessionId or valid totalRounds. gameSessionId: ${sessionId}, totalRounds: ${totalRoundsInSession}. Falling back to single report.`);
            return {
                gameSessionId: null, totalRounds: 1,
                riddlesInSession: [{
                    docId: latestEntryDocId,
                    question: latestEntryData.riddleText,
                    answer: latestEntryData.riddleAnswer,
                    roundNumber: latestEntryData.roundNumber || 1
                }]
            };
        }
        
        if (totalRoundsInSession === 1) { 
            logger.debug(`[RiddleStorage][${lowerChannelName}] Latest game (Doc ID: ${latestEntryDocId}, Session ID: ${sessionId}) was recorded as single round. Reporting that specific riddle.`);
             return {
                gameSessionId: sessionId, totalRounds: 1,
                riddlesInSession: [{
                    docId: latestEntryDocId,
                    question: latestEntryData.riddleText,
                    answer: latestEntryData.riddleAnswer,
                    roundNumber: latestEntryData.roundNumber || 1
                }]
            };
        }

        logger.info(`[RiddleStorage][${lowerChannelName}] Multi-round session detected (ID: ${sessionId}, TotalRounds: ${totalRoundsInSession}). Fetching all riddles for this session.`);
        const sessionRiddlesQuery = historyCollection
            .where('channelName', '==', lowerChannelName)
            .where('gameSessionId', '==', sessionId)
            .orderBy('roundNumber', 'asc')
            .limit(totalRoundsInSession + 5);
        logger.debug(`[RiddleStorage][${lowerChannelName}] Executing Firestore Query for session: channelName='${lowerChannelName}', gameSessionId='${sessionId}', orderBy='roundNumber ASC'`);
        let sessionRiddlesSnapshot;
        try {
            logger.debug(`[RiddleStorage][${lowerChannelName}] PRE-AWAIT for sessionRiddlesQuery.get() for session ${sessionId}`);
            sessionRiddlesSnapshot = await sessionRiddlesQuery.get();
            logger.debug(`[RiddleStorage][${lowerChannelName}] POST-AWAIT for sessionRiddlesQuery.get() for session ${sessionId}. Snapshot object: ${sessionRiddlesSnapshot ? 'exists' : 'null/undefined'}`);
        } catch (queryError) {
            logger.error({ err: queryError, message: queryError.message, stack: queryError.stack, channel: lowerChannelName, sessionId }, `[RiddleStorage] Firestore query FOR SESSION ${sessionId} FAILED.`);
            return {
                gameSessionId: sessionId, totalRounds: 1, 
                riddlesInSession: [{ docId: latestEntryDocId, question: latestEntryData.riddleText, answer: latestEntryData.riddleAnswer, roundNumber: latestEntryData.roundNumber || 1 }]
            };
        }
        if (!sessionRiddlesSnapshot) {
            logger.error(`[RiddleStorage][${lowerChannelName}] sessionRiddlesSnapshot IS NULL or UNDEFINED after get() for session ${sessionId}. This is very unexpected.`);
            return {
                gameSessionId: sessionId, totalRounds: 1,
                riddlesInSession: [{ docId: latestEntryDocId, question: latestEntryData.riddleText, answer: latestEntryData.riddleAnswer, roundNumber: latestEntryData.roundNumber || 1 }]
            };
        }
        logger.info(`[RiddleStorage][${lowerChannelName}] sessionRiddlesSnapshot for session ${sessionId} query completed. Size: ${sessionRiddlesSnapshot.size}. Empty: ${sessionRiddlesSnapshot.empty}. Expected approx: ${totalRoundsInSession}`);
        const riddlesInSession = [];
        if (!sessionRiddlesSnapshot.empty) {
            logger.debug(`[RiddleStorage][${lowerChannelName}] Processing ${sessionRiddlesSnapshot.size} docs from session ${sessionId} query...`);
            sessionRiddlesSnapshot.forEach(doc => {
                const data = doc.data();
                logger.debug(`[RiddleStorage][${lowerChannelName}]   Doc ${doc.id}: Round ${data.roundNumber}, GameSessionID Actual: ${data.gameSessionId}, Q: "${data.riddleText?.substring(0,20)}..."`);
                if (data.gameSessionId === sessionId && data.riddleText && data.riddleAnswer && typeof data.roundNumber === 'number') {
                     riddlesInSession.push({
                        docId: doc.id,
                        question: data.riddleText,
                        answer: data.riddleAnswer,
                        roundNumber: data.roundNumber
                    });
                } else {
                    logger.warn(`[RiddleStorage][${lowerChannelName}]   Doc ${doc.id} filtered out. Expected SessionID: ${sessionId}, Got: ${data.gameSessionId}. HasText: ${!!data.riddleText}, HasAnswer: ${!!data.riddleAnswer}, HasRoundNum: ${typeof data.roundNumber === 'number'}`);
                }
            });
            riddlesInSession.sort((a, b) => a.roundNumber - b.roundNumber);
            if (riddlesInSession.length === 0) {
                logger.warn(`[RiddleStorage][${lowerChannelName}] After processing, riddlesInSession array is EMPTY for session ID ${sessionId}. Falling back to single report using latest entry (Doc ID: ${latestEntryDocId}).`);
                return {
                    gameSessionId: sessionId, totalRounds: 1,
                    riddlesInSession: [{
                        docId: latestEntryDocId,
                        question: latestEntryData.riddleText,
                        answer: latestEntryData.riddleAnswer,
                        roundNumber: latestEntryData.roundNumber || 1
                    }]
                };
            }
            logger.info(`[RiddleStorage][${lowerChannelName}] Successfully populated ${riddlesInSession.length} riddles for session ID ${sessionId}.`);
            logger.debug(`[RiddleGameManager][${channelName}] Session Info for report decision: totalRoundsFromInfo=${totalRoundsInSession}, found ${riddlesInSession.length} riddles in session array.`);
            return { gameSessionId: sessionId, totalRounds: totalRoundsInSession, riddlesInSession };
        }
        logger.warn(`[RiddleStorage][${lowerChannelName}] Query for session ID ${sessionId} returned EMPTY results unexpectedly. Falling back to single report using latest entry (Doc ID: ${latestEntryDocId}).`);
        return {
            gameSessionId: sessionId, totalRounds: 1,
            riddlesInSession: [{
                docId: latestEntryDocId,
                question: latestEntryData.riddleText,
                answer: latestEntryData.riddleAnswer,
                roundNumber: latestEntryData.roundNumber || 1
            }]
        };
    } catch (error) {
        logger.error({ err: error, channel: lowerChannelName }, `[RiddleStorage] Error fetching latest session info for ${lowerChannelName}`);
        if (error.code === 5 && error.message && error.message.includes('index')) {
            logger.warn(`[RiddleStorage] Firestore index likely missing for getLatestCompletedSessionInfo queries. Please check Firestore console for index suggestions. You may need a composite index on (channelName ASC, gameSessionId ASC, roundNumber ASC) for the '${RIDDLE_GAME_HISTORY_COLLECTION}' collection, and also an index on (channelName ASC, timestamp DESC).`);
        }
        return null;
    }
}