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
            roundNumber: gameDetails.roundNumber || 1,
            totalRounds: gameDetails.totalRounds || 1,
            difficulty: gameDetails.difficulty || 'normal',
            timestamp: FieldValue.serverTimestamp()
        };
        
        // Save to history collection
        await colRef.add(sanitizedDetails);
        logger.debug(`[TriviaStorage] Recorded game result for channel ${sanitizedDetails.channel}`);
        
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

/**
 * Gets recent questions.
 * @param {string} channelName - Channel name.
 * @param {string} topic - Topic filter.
 * @param {number} limit - Number of questions to return.
 * @returns {Promise<string[]>} Array of recent question texts.
 */
async function getRecentQuestions(channelName, topic = null, limit = 30) {
    const db = _getDb();
    const colRef = db.collection(HISTORY_COLLECTION);
    const lowerChannelName = channelName.toLowerCase();
    
    try {
        let query = colRef.where('channel', '==', lowerChannelName);
        
        if (topic && topic !== 'general') {
            query = query.where('topic', '==', topic);
        }
        
        const snapshot = await query.orderBy('timestamp', 'desc').limit(limit).get();
        const recentQuestions = [];
        
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.question) {
                recentQuestions.push(data.question);
            }
        });
        
        logger.debug(`[TriviaStorage] Found ${recentQuestions.length} recent questions for channel ${lowerChannelName}${topic ? ` and topic ${topic}` : ''}.`);
        return recentQuestions;
    } catch (error) {
        logger.error({ err: error, channel: lowerChannelName, topic }, `[TriviaStorage] Error getting recent questions`);
        return [];
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
 * Gets recent unique answers given in a channel, optionally filtered by topic.
 * Used to prevent answer repetition.
 * @param {string} channelName - Channel name (without #).
 * @param {string|null} topic - Topic filter (optional).
 * @param {number} limit - Number of recent game results to check.
 * @returns {Promise<string[]>} Array of unique recent answer strings (lowercase).
 */
async function getRecentAnswers(channelName, topic = null, limit = 50) {
    const db = _getDb();
    const colRef = db.collection(HISTORY_COLLECTION);
    const lowerChannelName = channelName.toLowerCase();
    const recentAnswers = new Set(); // Use a Set for automatic uniqueness

    try {
        let query = colRef.where('channel', '==', lowerChannelName);

        // Optional topic filtering
        if (topic && topic !== 'general') {
            query = query.where('topic', '==', topic);
        }

        // Order by timestamp and limit
        const snapshot = await query.orderBy('timestamp', 'desc').limit(limit).get();

        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.answer && typeof data.answer === 'string') {
                // Add the lowercase version of the answer to the set
                recentAnswers.add(data.answer.toLowerCase());
            }
        });

        logger.debug(`[TriviaStorage] Found ${recentAnswers.size} unique recent answers for channel ${lowerChannelName}${topic ? ` and topic ${topic}` : ''} within last ${limit} results.`);
        return Array.from(recentAnswers); // Convert Set back to Array
    } catch (error) {
        // Log specific index errors if possible
        if (error.code === 5 && error.message.includes('index')) { // Firestore 'Failed Precondition' for missing index
             logger.warn({
                 channel: lowerChannelName,
                 topic: topic,
                 indexError: error.message // Log the specific index needed
             }, `[TriviaStorage] Firestore index likely missing for getRecentAnswers query. Performance may be impacted or query might fail.`);
             // Potentially fall back to a less specific query if absolutely needed,
             // but it's better to create the index. For now, just return empty on error.
             return [];
        }
        logger.error({ err: error, channel: lowerChannelName, topic }, `[TriviaStorage] Error getting recent answers`);
        return []; // Return empty array on error
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
    getRecentAnswers
};