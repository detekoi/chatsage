// src/components/trivia/triviaStorage.js
import { Firestore, FieldValue } from '@google-cloud/firestore';
import logger from '../../lib/logger.js';

// --- Firestore Collections ---
const CONFIG_COLLECTION = 'triviaGameConfigs';
const STATS_COLLECTION = 'triviaPlayerStats';
const HISTORY_COLLECTION = 'triviaGameHistory';
const QUESTIONS_COLLECTION = 'triviaQuestions';

// --- Firestore Client ---
let db = null;

/**
 * Custom error class for storage operations.
 */
class StorageError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'StorageError';
        this.cause = cause;
    }
}

/**
 * Initializes the Firestore client.
 * Uses Application Default Credentials or GOOGLE_APPLICATION_CREDENTIALS.
 */
async function initializeStorage() {
    logger.info("[TriviaStorage] Initializing Firestore client...");
    try {
        logger.debug("[TriviaStorage] Creating new Firestore client instance...");
        
        db = new Firestore();
        
        logger.debug("[TriviaStorage] Firestore client created, testing connection...");
        
        const testQuery = db.collection(CONFIG_COLLECTION).limit(1);
        const result = await testQuery.get();
        
        logger.debug(`[TriviaStorage] Test query successful. Found ${result.size} documents.`);
        logger.info("[TriviaStorage] Firestore client initialized successfully.");
    } catch (error) {
        logger.fatal({ 
            err: error, 
            message: error.message,
            code: error.code,
            stack: error.stack,
            projectId: process.env.GOOGLE_CLOUD_PROJECT || 'unknown'
        }, "[TriviaStorage] CRITICAL: Failed to initialize Firestore client.");
        
        const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        if (credPath) {
            logger.fatal(`[TriviaStorage] GOOGLE_APPLICATION_CREDENTIALS is set to: ${credPath}`);
        } else {
            logger.fatal("[TriviaStorage] GOOGLE_APPLICATION_CREDENTIALS environment variable is not set.");
        }
        
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
        throw new Error("[TriviaStorage] Storage not initialized. Call initializeStorage first.");
    }
    return db;
}

// --- Configuration Storage ---

/**
 * Loads configuration for a channel.
 * @param {string} channelName - The channel name.
 * @returns {Promise<object|null>} Config object or null if not found.
 */
async function loadChannelConfig(channelName) {
    const db = _getDb();
    const docRef = db.collection(CONFIG_COLLECTION).doc(channelName.toLowerCase());
    
    try {
        const docSnap = await docRef.get();
        if (docSnap.exists) {
            logger.debug(`[TriviaStorage] Loaded config for channel ${channelName}`);
            return docSnap.data();
        } else {
            logger.debug(`[TriviaStorage] No config found for channel ${channelName}`);
            return null;
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `[TriviaStorage] Error loading config for channel ${channelName}`);
        throw new StorageError(`Failed to load config for ${channelName}`, error);
    }
}

/**
 * Saves configuration for a channel.
 * @param {string} channelName - The channel name.
 * @param {object} config - Config object to save.
 * @returns {Promise<void>}
 */
async function saveChannelConfig(channelName, config) {
    const db = _getDb();
    const docRef = db.collection(CONFIG_COLLECTION).doc(channelName.toLowerCase());
    
    try {
        await docRef.set(config, { merge: true });
        logger.debug(`[TriviaStorage] Saved config for channel ${channelName}`);
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `[TriviaStorage] Error saving config for channel ${channelName}`);
        throw new StorageError(`Failed to save config for ${channelName}`, error);
    }
}

// --- Game History Storage ---

/**
 * Records the result of a completed game.
 * @param {object} gameDetails - Game result details.
 * @returns {Promise<void>}
 */
async function recordGameResult(gameDetails) {
    const db = _getDb();
    const colRef = db.collection(HISTORY_COLLECTION);
    
    try {
        // Create a sanitized copy with default values for all fields
        const sanitizedDetails = {
            channel: gameDetails.channel || 'unknown',
            topic: gameDetails.topic || 'general',
            question: gameDetails.question || 'Unknown question',
            answer: gameDetails.answer || 'Unknown',
            winner: gameDetails.winner || null,
            winnerDisplay: gameDetails.winnerDisplay || null,
            startTime: gameDetails.startTime || null,
            endTime: gameDetails.endTime || new Date().toISOString(),
            durationMs: gameDetails.durationMs || 0,
            reasonEnded: gameDetails.reasonEnded || 'unknown',
            difficulty: gameDetails.difficulty || 'normal',
            pointsAwarded: gameDetails.pointsAwarded !== undefined ? gameDetails.pointsAwarded : 0,
            searchUsed: typeof gameDetails.searchUsed === 'boolean' ? gameDetails.searchUsed : false,
            verified: typeof gameDetails.verified === 'boolean' ? gameDetails.verified : undefined,
            gameSessionId: gameDetails.gameSessionId || null, // Default to null if not provided
            roundNumber: gameDetails.roundNumber !== undefined ? gameDetails.roundNumber : 1,
            totalRounds: gameDetails.totalRounds !== undefined ? gameDetails.totalRounds : 1,
            timestamp: FieldValue.serverTimestamp()

        };
        
        // Save to history collection
        await colRef.add(sanitizedDetails);
        logger.debug(`[TriviaStorage] Recorded game result for channel ${sanitizedDetails.channel}. Session: ${sanitizedDetails.gameSessionId}, Round: ${sanitizedDetails.roundNumber}/${sanitizedDetails.totalRounds}`);
        
        // Optionally save the question to the bank if valid
        if (sanitizedDetails.question && sanitizedDetails.question !== 'Unknown question') {
            try {
                await _saveQuestionToBank(
                    sanitizedDetails.question,
                    sanitizedDetails.answer,
                    sanitizedDetails.topic,
                    sanitizedDetails.difficulty
                );
            } catch (questionError) {
                logger.warn({ err: questionError }, `[TriviaStorage] Error saving question to bank, but game result was saved.`);
            }
        }
    } catch (error) {
        logger.error({ err: error, channel: gameDetails?.channel }, `[TriviaStorage] Error recording game result`);
        throw new StorageError('Failed to record game result', error);
    }
}

/**
 * Saves a question to the question bank.
 * @param {string} question - The question text.
 * @param {string} answer - The answer text.
 * @param {string} topic - The topic.
 * @param {string} difficulty - The difficulty.
 * @param {boolean} searchUsed - Whether search was used to generate the question.
 * @param {boolean} verified - Whether the question was verified as factual.
 * @returns {Promise<void>}
 * @private
 */
async function _saveQuestionToBank(question, answer, topic = 'general', difficulty = 'normal', searchUsed = false, verified = false) {
    const db = _getDb();
    const questionHash = Buffer.from(question || 'Unknown question').toString('base64').substring(0, 40);
    const docRef = db.collection(QUESTIONS_COLLECTION).doc(questionHash);
    
    try {
        const docSnap = await docRef.get();
        
        if (docSnap.exists) {
            // Update existing question - explicitly define all fields
            await docRef.update({
                answer: answer || 'Unknown',
                topic: topic || 'general',
                difficulty: difficulty || 'normal',
                lastUsed: FieldValue.serverTimestamp(),
                usageCount: FieldValue.increment(1),
                searchUsed: searchUsed || false,
                verified: (docSnap.data().verified !== undefined ? docSnap.data().verified : false)
            });
        } else {
            // Create new question - explicitly define all fields
            await docRef.set({
                question: question || 'Unknown question',
                answer: answer || 'Unknown',
                topic: topic || 'general',
                difficulty: difficulty || 'normal',
                created: FieldValue.serverTimestamp(),
                lastUsed: FieldValue.serverTimestamp(),
                usageCount: 1,
                searchUsed: searchUsed || false,
                verified: false
            });
        }
        
        logger.debug(`[TriviaStorage] ${docSnap.exists ? 'Updated' : 'Added'} question to bank: "${(question || 'Unknown question').substring(0, 30)}..."`);
    } catch (error) {
        logger.error({ err: error }, `[TriviaStorage] Error saving question to bank`);
        throw error;
    }
}

/**
 * Flags a question as problematic (e.g., hallucinated or reported by user).
 * @param {string} questionText - The question text to flag.
 * @param {string} reason - Reason for flagging (default: hallucination).
 * @returns {Promise<void>}
 */
async function reportProblemQuestion(questionText, reason = "hallucination") {
    const db = _getDb();
    const questionHash = Buffer.from(questionText).toString('base64').substring(0, 40);
    const docRef = db.collection(QUESTIONS_COLLECTION).doc(questionHash);
    try {
        await docRef.update({
            flaggedAsProblem: true,
            problemReason: reason,
            flaggedTimestamp: FieldValue.serverTimestamp()
        });
        logger.info(`[TriviaStorage] Flagged problematic question: ${questionText.substring(0, 30)}... (${reason})`);
    } catch (error) {
        logger.error({ err: error }, `[TriviaStorage] Error flagging problem question`);
    }
}

// --- Player Stats Storage ---

/**
 * Updates a player's score/stats.
 * @param {string} username - Player's username.
 * @param {string} channelName - Channel name.
 * @param {number} points - Points to add.
 * @param {string} displayName - Player's display name.
 * @returns {Promise<void>}
 */
async function updatePlayerScore(username, channelName, points = 1, displayName = null) {
    const db = _getDb();
    const lowerUsername = username.toLowerCase();
    const lowerChannel = channelName.toLowerCase();
    const docRef = db.collection(STATS_COLLECTION).doc(lowerUsername);
    
    try {
        const updateData = {
            globalCorrect: FieldValue.increment(1),
            globalPoints: FieldValue.increment(points),
            globalParticipation: FieldValue.increment(1),
            lastCorrectTimestamp: FieldValue.serverTimestamp(),
            channels: {
                [lowerChannel]: {
                    correct: FieldValue.increment(1),
                    points: FieldValue.increment(points),
                    participation: FieldValue.increment(1),
                    lastCorrectTimestamp: FieldValue.serverTimestamp()
                }
            }
        };
        
        if (displayName) {
            updateData.displayName = displayName;
        }
        
        await docRef.set(updateData, { merge: true });
        logger.debug(`[TriviaStorage] Updated stats for player ${lowerUsername} in channel ${lowerChannel} (+${points} points)`);
    } catch (error) {
        logger.error({ err: error, player: lowerUsername, channel: lowerChannel }, `[TriviaStorage] Error updating player score`);
        throw new StorageError(`Failed to update player score for ${lowerUsername} in ${lowerChannel}`, error);
    }
}

/**
 * Gets player statistics.
 * @param {string} username - Player's username.
 * @param {string} channelName - Channel name.
 * @returns {Promise<object|null>} Player stats or null.
 */
async function getPlayerStats(username, channelName = null) {
    const db = _getDb();
    const lowerUsername = username.toLowerCase();
    const docRef = db.collection(STATS_COLLECTION).doc(lowerUsername);
    
    try {
        const docSnap = await docRef.get();
        if (docSnap.exists) {
            const data = docSnap.data();
            
            if (channelName) {
                const lowerChannel = channelName.toLowerCase();
                
                return {
                    ...data,
                    channelStats: data.channels?.[lowerChannel] || null,
                    correct: data.globalCorrect || 0,
                    points: data.globalPoints || 0,
                    participation: data.globalParticipation || 0
                };
            }
            
            return data;
        } else {
            return null;
        }
    } catch (error) {
        logger.error({ 
            err: error, 
            player: lowerUsername,
            channel: channelName
        }, `[TriviaStorage] Error getting player stats`);
        return null;
    }
}

/**
 * Gets the leaderboard.
 * @param {string} channelName - Channel name.
 * @param {number} limit - Number of players to return.
 * @returns {Promise<Array<{id: string, data: object}>>} Leaderboard data.
 */
async function getLeaderboard(channelName = null, limit = 10) {
    const db = _getDb();
    const colRef = db.collection(STATS_COLLECTION);
    const leaderboard = [];
    
    try {
        if (channelName) {
            const lowerChannel = channelName.toLowerCase();
            logger.debug(`[TriviaStorage] Retrieving channel-specific leaderboard for ${lowerChannel}`);
            
            // For channel-specific leaderboard we need to query differently
            const allSnapshot = await colRef
                .where(`channels.${lowerChannel}`, '!=', null)
                .limit(limit * 3)
                .get();
            
            // Extract and sort manually
            const players = [];
            allSnapshot.forEach(doc => {
                const data = doc.data();
                const channelData = data.channels?.[lowerChannel];
                
                if (channelData) {
                    players.push({
                        id: doc.id,
                        data: {
                            ...data,
                            channelCorrect: channelData.correct || 0,
                            channelPoints: channelData.points || 0,
                            channelParticipation: channelData.participation || 0,
                            displayName: data.displayName || doc.id
                        }
                    });
                }
            });
            
            // Sort by channel-specific points
            players.sort((a, b) => b.data.channelPoints - a.data.channelPoints);
            
            // Take top N
            return players.slice(0, limit);
        } else {
            // Global leaderboard - sort by globalPoints
            const snapshot = await colRef.orderBy('globalPoints', 'desc').limit(limit).get();
            
            snapshot.forEach(doc => {
                const data = doc.data();
                leaderboard.push({ 
                    id: doc.id, 
                    data: {
                        ...data,
                        correct: data.globalCorrect || 0,
                        points: data.globalPoints || 0,
                        participation: data.globalParticipation || 0
                    }
                });
            });
            
            logger.debug(`[TriviaStorage] Retrieved global leaderboard with ${leaderboard.length} players.`);
            return leaderboard;
        }
    } catch (error) {
        logger.error({ 
            err: error,
            channel: channelName || 'global'
        }, `[TriviaStorage] Error retrieving leaderboard.`);
        return [];
    }
}

// --- Recent Question Retrieval ---
/**
 * Gets recent questions asked in a channel, optionally filtered by topic.
 * Fetches from the history collection.
 * @param {string} channelName - Channel name (without #).
 * @param {string|null} topic - Topic filter (optional).
 * @param {number} limit - Number of questions to return.
 * @returns {Promise<string[]>} Array of recent question texts.
 */
async function getRecentQuestions(channelName, topic = null, limit = 30) {
    const db = _getDb();
    const colRef = db.collection(HISTORY_COLLECTION);
    const lowerChannelName = channelName.toLowerCase();
    const recentQuestions = new Set(); // Use Set to avoid duplicates within the fetch limit

    try {
        let query = colRef.where('channel', '==', lowerChannelName);

        // Optional topic filtering
        if (topic && topic !== 'general') {
            query = query.where('topic', '==', topic);
        }

        // Order by timestamp and limit
        let snapshot;
        try {
            snapshot = await query.orderBy('timestamp', 'desc').limit(limit).get();
        } catch (indexError) {
            // Handle potential missing index error gracefully
            if (indexError.code === 5 && indexError.message.includes('index')) { // Firestore 'Failed Precondition' for missing index
                logger.warn({ channel: lowerChannelName, topic, indexError: indexError.message }, `[TriviaStorage] Firestore index likely missing for getRecentQuestions query. Performance may be impacted.`);
                // Fallback: Query without topic filter if topic was specified, or just fetch more and filter manually
                if (topic && topic !== 'general') {
                    logger.warn(`[TriviaStorage] Retrying getRecentQuestions without topic filter for ${lowerChannelName}.`);
                    query = colRef.where('channel', '==', lowerChannelName).orderBy('timestamp', 'desc').limit(limit * 2); // Fetch more to filter later
                    snapshot = await query.get();
                } else {
                    // If no topic or index error on basic query, rethrow
                    throw indexError;
                }
            } else {
                // Rethrow unexpected errors
                throw indexError;
            }
        }

        snapshot.forEach(doc => {
            const data = doc.data();
            // Add the question text to the set
            if (data.question && typeof data.question === 'string') {
                // Filter by topic here if we fell back due to index error
                if (topic && topic !== 'general' && data.topic !== topic) {
                    // Skip if topic doesn't match in fallback scenario
                } else {
                    recentQuestions.add(data.question);
                }
            }
        });

        logger.debug(`[TriviaStorage] Found ${recentQuestions.size} unique recent questions for channel ${lowerChannelName}${topic ? ` and topic ${topic}` : ''} within last ${limit} results.`);
        return Array.from(recentQuestions); // Convert Set back to Array
    } catch (error) {
        logger.error({ err: error, channel: lowerChannelName, topic }, `[TriviaStorage] Error getting recent questions`);
        throw new StorageError(`Failed to get recent questions for ${lowerChannelName}`, error); // Throw error for manager to handle
    }
}

/**
 * Clears leaderboard data for a channel.
 * @param {string} channelName - Channel name.
 * @returns {Promise<{success: boolean, message: string, clearedCount: number}>} Result.
 */
async function clearChannelLeaderboardData(channelName) {
    const db = _getDb();
    const lowerChannel = channelName.toLowerCase();
    const statsCollection = db.collection(STATS_COLLECTION);
    let clearedCount = 0;
    const batchSize = 100;
    let lastVisible = null;
    
    logger.info(`[TriviaStorage] Starting leaderboard clear process for channel: ${lowerChannel}`);
    
    try {
        const fieldPath = `channels.${lowerChannel}`;
        let query = statsCollection.where(fieldPath, '!=', null).limit(batchSize);
        
        while (true) {
            const snapshot = await query.get();
            if (snapshot.empty) {
                break;
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
            logger.debug(`[TriviaStorage] Cleared leaderboard data batch for ${snapshot.size} players. Total cleared: ${clearedCount}`);
            
            if (snapshot.size < batchSize) {
                break;
            }
            
            lastVisible = snapshot.docs[snapshot.docs.length - 1];
            query = statsCollection
                .where(fieldPath, '!=', null)
                .startAfter(lastVisible)
                .limit(batchSize);
            
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        logger.info(`[TriviaStorage] Successfully cleared leaderboard data for ${clearedCount} players in channel ${lowerChannel}.`);
        return { 
            success: true, 
            message: `Successfully cleared trivia leaderboard data for ${clearedCount} players.`, 
            clearedCount 
        };
    } catch (error) {
        logger.error({ err: error, channel: lowerChannel }, `[TriviaStorage] Error clearing leaderboard data.`);
        return { 
            success: false, 
            message: `An error occurred while clearing leaderboard data. ${clearedCount} records might have been cleared before the error.`, 
            clearedCount 
        };
    }
}

/**
 * Gets the gameSessionId and item details of the most recently completed game session.
 * @param {string} channelName - The channel name (without #)
 * @returns {Promise<{gameSessionId: string | null, totalRounds: number, itemsInSession: Array<{docId: string, itemData: {question: string, answer: string}, roundNumber: number}> }|null>}
 * itemData will be an object { question, answer } for Trivia.
 * Returns null if no history found or an error occurs.
 */
async function getLatestCompletedSessionInfo(channelName) {
    const db = _getDb();
    const historyCollection = db.collection(HISTORY_COLLECTION);
    const lowerChannelName = channelName.toLowerCase();

    try {
        logger.debug(`[TriviaStorage][${lowerChannelName}] Fetching latest game entry.`);
        const latestEntrySnapshot = await historyCollection
            .where('channel', '==', lowerChannelName)
            .orderBy('timestamp', 'desc')
            .limit(1)
            .get();

        if (latestEntrySnapshot.empty) {
            logger.debug(`[TriviaStorage][${lowerChannelName}] No game history found.`);
            return null;
        }

        const latestEntryDoc = latestEntrySnapshot.docs[0];
        const latestEntryData = latestEntryDoc.data();
        const gameSessionId = latestEntryData.gameSessionId || null;
        const totalRoundsInSession = latestEntryData.totalRounds || 1;
        const latestRoundNumber = latestEntryData.roundNumber || 1;

        logger.debug(`[TriviaStorage][${lowerChannelName}] Latest entry: ID=${latestEntryDoc.id}, SessionID=${gameSessionId}, TotalRounds=${totalRoundsInSession}, Question=${latestEntryData.question?.substring(0,30)}...`);

        if (gameSessionId && totalRoundsInSession > 1) {
            logger.debug(`[TriviaStorage][${lowerChannelName}] Multi-round session detected (ID: ${gameSessionId}). Fetching all questions for this session.`);
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
                    if (data.gameSessionId === gameSessionId && data.question && data.answer && typeof data.roundNumber === 'number') {
                        itemsInSession.push({
                            docId: doc.id,
                            itemData: { question: data.question, answer: data.answer },
                            roundNumber: data.roundNumber
                        });
                    }
                });
            }
            
            if (itemsInSession.length > 0) {
                logger.info(`[TriviaStorage][${lowerChannelName}] Found ${itemsInSession.length} questions for session ID ${gameSessionId}.`);
                return { gameSessionId, totalRounds: totalRoundsInSession, itemsInSession };
            } else {
                logger.warn(`[TriviaStorage][${lowerChannelName}] Session query for ID ${gameSessionId} was empty. Falling back to latest entry.`);
                return {
                    gameSessionId,
                    totalRounds: 1,
                    itemsInSession: [{
                        docId: latestEntryDoc.id,
                        itemData: { question: latestEntryData.question, answer: latestEntryData.answer },
                        roundNumber: latestRoundNumber
                    }]
                };
            }
        } else {
            logger.debug(`[TriviaStorage][${lowerChannelName}] Single round game or no session ID. Reporting only last question.`);
            return {
                gameSessionId,
                totalRounds: 1,
                itemsInSession: [{
                    docId: latestEntryDoc.id,
                    itemData: { question: latestEntryData.question, answer: latestEntryData.answer },
                    roundNumber: latestRoundNumber
                }]
            };
        }
    } catch (error) {
        logger.error({ err: error, channel: lowerChannelName }, `[TriviaStorage] Error fetching latest session info.`);
        if (error.code === 5 && error.message && error.message.includes('index')) {
            logger.warn(`[TriviaStorage] Firestore index likely missing for getLatestCompletedSessionInfo query on collection '${HISTORY_COLLECTION}'. You might need composite indexes involving 'channel', 'timestamp', 'gameSessionId', and 'roundNumber'.`);
        }
        return null;
    }
}

/**
 * Flags a specific Trivia game history document as problematic by its Firestore ID.
 * @param {string} docId - The Firestore document ID of the game history entry.
 * @param {string} reason - The reason for flagging.
 * @param {string} reportedByUsername - Username of the reporter.
 * @returns {Promise<void>}
 * @throws {StorageError} If updating fails.
 */
async function flagTriviaQuestionByDocId(docId, reason, reportedByUsername) {
    const db = _getDb();
    const docRef = db.collection(HISTORY_COLLECTION).doc(docId);
    logger.info(`[TriviaStorage] Flagging Trivia entry ${docId} as problematic. Reason: "${reason}", Reported by: ${reportedByUsername}`);
    try {
        await docRef.update({
            flaggedAsProblem: true,
            problemReason: reason,
            reportedBy: reportedByUsername.toLowerCase(),
            flaggedTimestamp: FieldValue.serverTimestamp()
        });
        logger.debug(`[TriviaStorage] Successfully flagged Trivia entry ${docId}.`);
    } catch (error) {
        logger.error({ err: error, docId, reason }, `[TriviaStorage] Error flagging Trivia entry ${docId}.`);
        throw new StorageError(`Failed to flag Trivia entry ${docId}`, error);
    }
}

export {
    initializeStorage,
    StorageError,
    loadChannelConfig,
    saveChannelConfig,
    recordGameResult,
    reportProblemQuestion,
    updatePlayerScore,
    getPlayerStats,
    getLeaderboard,
    getRecentQuestions,
    clearChannelLeaderboardData,
    getLatestCompletedSessionInfo,
    flagTriviaQuestionByDocId
};