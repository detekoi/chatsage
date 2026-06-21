// src/components/trivia/triviaStorage.js
import { FieldValue } from '../../lib/firestore.js';
import { BaseGameStorage, StorageError } from '../../lib/baseGameStorage.js';
import logger from '../../lib/logger.js';

// --- Firestore Collections ---
const CONFIG_COLLECTION = 'triviaGameConfigs';
const STATS_COLLECTION = 'triviaPlayerStats';
const HISTORY_COLLECTION = 'triviaGameHistory';
const QUESTIONS_COLLECTION = 'triviaQuestions';

// ── Trivia-specific storage that extends the shared base ──────────

class TriviaStorage extends BaseGameStorage {
    constructor() {
        super({
            gameName: 'Trivia',
            configCollection: CONFIG_COLLECTION,
            statsCollection: STATS_COLLECTION,
            historyCollection: HISTORY_COLLECTION,
        });
    }

    /**
     * Trivia overrides recordGameResult to sanitize fields and
     * optionally save the question to the question bank.
     */
    async recordGameResult(gameDetails) {
        const db = this._getDb();
        const colRef = db.collection(this.historyCollection);

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
                gameSessionId: gameDetails.gameSessionId || null,
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
                    await this._saveQuestionToBank(
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
     * For getLatestCompletedSessionInfo: extract question/answer from history doc.
     */
    _extractItemData(data) {
        if (!data.question || !data.answer) return null;
        return { question: data.question, answer: data.answer };
    }

    // ── Trivia-specific methods ────────────────────────────────────────

    /**
     * Saves a question to the question bank.
     * @private
     */
    async _saveQuestionToBank(question, answer, topic = 'general', difficulty = 'normal', searchUsed = false, _verified = false) {
        const db = this._getDb();
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
     */
    async reportProblemQuestion(questionText, reason = "hallucination") {
        const db = this._getDb();
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

    /**
     * Gets player statistics with trivia-specific field aliases.
     */
    async getPlayerStats(username, channelName = null) {
        const lowerUsername = username.toLowerCase();
        const docRef = this._getDb().collection(this.statsCollection).doc(lowerUsername);

        try {
            const docSnap = await docRef.get();
            if (docSnap.exists) {
                const data = docSnap.data();

                if (channelName) {
                    const lowerChannel = channelName.toLowerCase();

                    return {
                        ...data,
                        channelStats: data.channels?.[lowerChannel] || null,
                        correct: data.globalSuccesses || data.globalCorrect || 0,
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

    // --- Recent Question Retrieval ---

    /**
     * Gets recent questions asked in a channel, optionally filtered by topic.
     */
    async getRecentQuestions(channelName, topic = null, limit = 30) {
        const db = this._getDb();
        const colRef = db.collection(HISTORY_COLLECTION);
        const lowerChannelName = channelName.toLowerCase();
        const recentQuestions = new Set();

        try {
            let query = colRef.where('channel', '==', lowerChannelName);

            if (topic && topic !== 'general') {
                query = query.where('topic', '==', topic);
            }

            let snapshot;
            try {
                snapshot = await query.orderBy('timestamp', 'desc').limit(limit).get();
            } catch (indexError) {
                if (indexError.code === 5 && indexError.message.includes('index')) {
                    logger.warn({ channel: lowerChannelName, topic, indexError: indexError.message }, `[TriviaStorage] Firestore index likely missing for getRecentQuestions query. Performance may be impacted.`);
                    if (topic && topic !== 'general') {
                        logger.warn(`[TriviaStorage] Retrying getRecentQuestions without topic filter for ${lowerChannelName}.`);
                        query = colRef.where('channel', '==', lowerChannelName).orderBy('timestamp', 'desc').limit(limit * 2);
                        snapshot = await query.get();
                    } else {
                        throw indexError;
                    }
                } else {
                    throw indexError;
                }
            }

            snapshot.forEach(doc => {
                const data = doc.data();
                if (data.question && typeof data.question === 'string') {
                    if (topic && topic !== 'general' && data.topic !== topic) {
                        // Skip if topic doesn't match in fallback scenario
                    } else {
                        recentQuestions.add(data.question);
                    }
                }
            });

            logger.debug(`[TriviaStorage] Found ${recentQuestions.size} unique recent questions for channel ${lowerChannelName}${topic ? ` and topic ${topic}` : ''} within last ${limit} results.`);
            return Array.from(recentQuestions);
        } catch (error) {
            logger.error({ err: error, channel: lowerChannelName, topic }, `[TriviaStorage] Error getting recent questions`);
            throw new StorageError(`Failed to get recent questions for ${lowerChannelName}`, error);
        }
    }

    /**
     * Gets recent answers used in a channel, optionally filtered by topic.
     */
    async getRecentAnswers(channelName, topic = null, limit = 30) {
        const db = this._getDb();
        const colRef = db.collection(HISTORY_COLLECTION);
        const lowerChannelName = channelName.toLowerCase();
        const recentAnswers = new Set();

        try {
            let query = colRef.where('channel', '==', lowerChannelName);

            if (topic && topic !== 'general') {
                query = query.where('topic', '==', topic);
            }

            let snapshot;
            try {
                snapshot = await query.orderBy('timestamp', 'desc').limit(limit).get();
            } catch (indexError) {
                if (indexError.code === 5 && indexError.message.includes('index')) {
                    logger.warn({ channel: lowerChannelName, topic, indexError: indexError.message }, `[TriviaStorage] Firestore index likely missing for getRecentAnswers query. Performance may be impacted.`);
                    if (topic && topic !== 'general') {
                        logger.warn(`[TriviaStorage] Retrying getRecentAnswers without topic filter for ${lowerChannelName}.`);
                        query = colRef.where('channel', '==', lowerChannelName).orderBy('timestamp', 'desc').limit(limit * 2);
                        snapshot = await query.get();
                    } else {
                        throw indexError;
                    }
                } else {
                    throw indexError;
                }
            }

            snapshot.forEach(doc => {
                const data = doc.data();
                const ans = typeof data.answer === 'string' ? data.answer.trim() : '';
                if (ans) {
                    if (topic && topic !== 'general' && data.topic !== topic) {
                        // skip non-matching topic if we fell back
                    } else {
                        recentAnswers.add(ans.toLowerCase());
                    }
                }
            });

            logger.debug(`[TriviaStorage] Found ${recentAnswers.size} unique recent answers for channel ${lowerChannelName}${topic ? ` and topic ${topic}` : ''} within last ${limit} results.`);
            return Array.from(recentAnswers);
        } catch (error) {
            logger.error({ err: error, channel: lowerChannelName, topic }, `[TriviaStorage] Error getting recent answers`);
            throw new StorageError(`Failed to get recent answers for ${lowerChannelName}`, error);
        }
    }
}

// ── Singleton instance ─────────────────────────────────────────────

const triviaStorage = new TriviaStorage();

// ── Backward-compatible named exports ──────────────────────────────

const initializeStorage = () => triviaStorage.initializeStorage();
const loadChannelConfig = (channelName) => triviaStorage.loadChannelConfig(channelName);
const saveChannelConfig = (channelName, config) => triviaStorage.saveChannelConfig(channelName, config);
const recordGameResult = (gameDetails) => triviaStorage.recordGameResult(gameDetails);
const reportProblemQuestion = (questionText, reason) => triviaStorage.reportProblemQuestion(questionText, reason);
const updatePlayerScore = (username, channelName, points, displayName) => triviaStorage.updatePlayerScore(username, channelName, points, displayName);
const getPlayerStats = (username, channelName) => triviaStorage.getPlayerStats(username, channelName);
const getLeaderboard = (channelName, limit) => triviaStorage.getLeaderboard(channelName, limit);
const getRecentQuestions = (channelName, topic, limit) => triviaStorage.getRecentQuestions(channelName, topic, limit);
const getRecentAnswers = (channelName, topic, limit) => triviaStorage.getRecentAnswers(channelName, topic, limit);
const clearChannelLeaderboardData = (channelName) => triviaStorage.clearChannelLeaderboardData(channelName);
const getLatestCompletedSessionInfo = (channelName) => triviaStorage.getLatestCompletedSessionInfo(channelName);
const flagTriviaQuestionByDocId = (docId, reason, reportedByUsername) => triviaStorage.flagHistoryEntryByDocId(docId, reason, reportedByUsername);

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
    getRecentAnswers,
    clearChannelLeaderboardData,
    getLatestCompletedSessionInfo,
    flagTriviaQuestionByDocId
};