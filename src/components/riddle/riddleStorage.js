// src/components/riddle/riddleStorage.js
import { FieldValue, Timestamp } from '../../lib/firestore.js';
import { BaseGameStorage, StorageError } from '../../lib/baseGameStorage.js';
import logger from '../../lib/logger.js';

// --- Firestore Collections ---
const CONFIG_COLLECTION = 'riddleGameConfigs';
const STATS_COLLECTION = 'riddlePlayerStats';
const HISTORY_COLLECTION = 'riddleGameHistory';
const RECENT_KEYWORDS_COLLECTION = 'riddleRecentKeywords';
const RECENT_ANSWERS_COLLECTION = 'riddleRecentAnswers';

const RECENT_KEYWORDS_TTL_DAYS = 7;

// Re-export StorageError under the old name for backward compatibility
export { StorageError as RiddleStorageError };

// ── Riddle-specific storage that extends the shared base ──────────

class RiddleStorage extends BaseGameStorage {
    constructor() {
        super({
            gameName: 'Riddle',
            configCollection: CONFIG_COLLECTION,
            statsCollection: STATS_COLLECTION,
            historyCollection: HISTORY_COLLECTION,
        });
    }

    /**
     * For the base getLatestCompletedSessionInfo: extract question/answer from history doc.
     * Used by the base class's generic session info method.
     */
    _extractItemData(data) {
        if (!data.riddleText || !data.riddleAnswer) return null;
        return { question: data.riddleText, answer: data.riddleAnswer };
    }

    /**
     * Override getLatestCompletedSessionInfo for riddle-specific format.
     *
     * Riddle game manager expects the response to use `riddlesInSession` (not
     * `itemsInSession`) with `question`/`answer` fields.
     */
    async getLatestCompletedSessionInfo(channelName) {
        const db = this._getDb();
        const historyCol = db.collection(this.historyCollection);
        const lowerChannelName = channelName.toLowerCase();

        try {
            logger.debug(`[RiddleStorage][${lowerChannelName}] Fetching latest riddle entry.`);

            const latestEntrySnapshot = await historyCol
                .where('channel', '==', lowerChannelName)
                .orderBy('timestamp', 'desc')
                .limit(1)
                .get();

            if (latestEntrySnapshot.empty) {
                logger.debug(`[RiddleStorage][${lowerChannelName}] No riddle history found.`);
                return null;
            }

            const latestEntryDoc = latestEntrySnapshot.docs[0];
            const latestEntryData = latestEntryDoc.data();
            const sessionId = latestEntryData.gameSessionId;
            const totalRoundsInSession = latestEntryData.totalRounds;

            logger.debug(`[RiddleStorage][${lowerChannelName}] Latest entry: ID=${latestEntryDoc.id}, SessionID=${sessionId}, TotalRounds=${totalRoundsInSession}`);

            if (!sessionId || typeof totalRoundsInSession !== 'number') {
                logger.warn(`[RiddleStorage][${lowerChannelName}] Latest entry missing gameSessionId or valid totalRounds. Falling back to single report.`);
                return {
                    gameSessionId: null, totalRounds: 1,
                    riddlesInSession: [{
                        docId: latestEntryDoc.id,
                        question: latestEntryData.riddleText,
                        answer: latestEntryData.riddleAnswer,
                        roundNumber: latestEntryData.roundNumber || 1
                    }]
                };
            }

            if (totalRoundsInSession === 1) {
                logger.debug(`[RiddleStorage][${lowerChannelName}] Single round game. Reporting latest riddle.`);
                return {
                    gameSessionId: sessionId, totalRounds: 1,
                    riddlesInSession: [{
                        docId: latestEntryDoc.id,
                        question: latestEntryData.riddleText,
                        answer: latestEntryData.riddleAnswer,
                        roundNumber: latestEntryData.roundNumber || 1
                    }]
                };
            }

            // Multi-round: fetch all riddles for this session
            logger.info(`[RiddleStorage][${lowerChannelName}] Multi-round session detected (ID: ${sessionId}, TotalRounds: ${totalRoundsInSession}). Fetching all riddles.`);
            let sessionRiddlesSnapshot;
            try {
                const sessionRiddlesQuery = historyCol
                    .where('channel', '==', lowerChannelName)
                    .where('gameSessionId', '==', sessionId)
                    .orderBy('roundNumber', 'asc')
                    .limit(totalRoundsInSession + 5);

                sessionRiddlesSnapshot = await sessionRiddlesQuery.get();
            } catch (queryError) {
                logger.error({ err: queryError, channel: lowerChannelName, sessionId }, `[RiddleStorage] Session query for ${sessionId} failed.`);
                return {
                    gameSessionId: sessionId, totalRounds: 1,
                    riddlesInSession: [{ docId: latestEntryDoc.id, question: latestEntryData.riddleText, answer: latestEntryData.riddleAnswer, roundNumber: latestEntryData.roundNumber || 1 }]
                };
            }

            if (!sessionRiddlesSnapshot || sessionRiddlesSnapshot.empty) {
                logger.warn(`[RiddleStorage][${lowerChannelName}] Session query for ${sessionId} returned empty. Falling back to single report.`);
                return {
                    gameSessionId: sessionId, totalRounds: 1,
                    riddlesInSession: [{ docId: latestEntryDoc.id, question: latestEntryData.riddleText, answer: latestEntryData.riddleAnswer, roundNumber: latestEntryData.roundNumber || 1 }]
                };
            }

            const riddlesInSession = [];
            sessionRiddlesSnapshot.forEach(doc => {
                const data = doc.data();
                if (data.gameSessionId === sessionId && data.riddleText && data.riddleAnswer && typeof data.roundNumber === 'number') {
                    riddlesInSession.push({
                        docId: doc.id,
                        question: data.riddleText,
                        answer: data.riddleAnswer,
                        roundNumber: data.roundNumber
                    });
                }
            });
            riddlesInSession.sort((a, b) => a.roundNumber - b.roundNumber);

            if (riddlesInSession.length === 0) {
                logger.warn(`[RiddleStorage][${lowerChannelName}] After processing, riddlesInSession is empty for session ${sessionId}. Falling back.`);
                return {
                    gameSessionId: sessionId, totalRounds: 1,
                    riddlesInSession: [{ docId: latestEntryDoc.id, question: latestEntryData.riddleText, answer: latestEntryData.riddleAnswer, roundNumber: latestEntryData.roundNumber || 1 }]
                };
            }

            logger.info(`[RiddleStorage][${lowerChannelName}] Found ${riddlesInSession.length} riddles for session ${sessionId}.`);
            return { gameSessionId: sessionId, totalRounds: totalRoundsInSession, riddlesInSession };
        } catch (error) {
            logger.error({ err: error, channel: lowerChannelName }, `[RiddleStorage] Error fetching latest session info.`);
            if (error.code === 5 && error.message?.includes('index')) {
                logger.warn(`[RiddleStorage] Firestore index likely missing for getLatestCompletedSessionInfo query on '${this.historyCollection}'.`);
            }
            return null;
        }
    }

    // ── Riddle-specific methods ────────────────────────────────────────

    /**
     * Records a riddle game result with riddle-specific fields.
     * Uses the canonical `channel` field for the channel name.
     */
    async recordRiddleResult(details) {
        const db = this._getDb();
        const historyCol = db.collection(this.historyCollection);
        const dataToSave = {
            ...details,
            // Ensure canonical 'channel' field is set, normalizing from legacy 'channelName'
            channel: (details.channel || details.channelName || 'unknown').toLowerCase(),
            timestamp: FieldValue.serverTimestamp(),
        };
        try {
            await historyCol.add(dataToSave);
            logger.debug(`[RiddleStorage] Recorded riddle result for channel ${dataToSave.channel}`);
        } catch (error) {
            logger.error({ err: error, details }, `[RiddleStorage] Error recording riddle result`);
            throw new StorageError('Failed to record riddle game result', error);
        }
    }

    /**
     * Retrieves the most recent riddle played in a channel.
     */
    async getMostRecentRiddlePlayed(channelName) {
        const db = this._getDb();
        const historyCol = db.collection(this.historyCollection);
        const lowerChannelName = channelName.toLowerCase();

        logger.debug(`[RiddleStorage] Fetching most recent riddle for channel ${lowerChannelName}`);
        try {
            const snapshot = await historyCol
                .where('channel', '==', lowerChannelName)
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
                question: data.riddleText,
                answer: data.riddleAnswer,
                topic: data.topic,
                keywords: data.keywords || []
            };
        } catch (error) {
            logger.error({ err: error, channel: lowerChannelName }, `[RiddleStorage] Error fetching most recent riddle for ${lowerChannelName}`);
            if (error.code === 5 && error.message?.includes('index')) {
                logger.warn(`[RiddleStorage] Firestore index likely missing for getMostRecentRiddlePlayed query.`);
            }
            throw new StorageError(`Failed to get most recent riddle for ${lowerChannelName}`, error);
        }
    }

    // --- Recent Riddle Keywords ---

    async saveRiddleKeywords(channelName, keywords) {
        if (!keywords || keywords.length === 0) {
            logger.warn(`[RiddleStorage] Attempted to save empty keywords for channel ${channelName}. Skipping.`);
            return;
        }
        const db = this._getDb();
        const keywordsCol = db.collection(RECENT_KEYWORDS_COLLECTION);
        const dataToSave = {
            channelName: channelName.toLowerCase(),
            keywords,
            createdAt: FieldValue.serverTimestamp()
        };
        try {
            await keywordsCol.add(dataToSave);
            logger.debug(`[RiddleStorage] Saved riddle keywords for channel ${channelName}: ${keywords.join(', ')}`);
        } catch (error) {
            logger.error({ err: error, channel: channelName, keywords }, `[RiddleStorage] Error saving riddle keywords`);
            throw new StorageError('Failed to save riddle keywords', error);
        }
    }

    async getRecentKeywords(channelName, limit = 50) {
        const db = this._getDb();
        const keywordsCol = db.collection(RECENT_KEYWORDS_COLLECTION);
        const recentKeywordSets = [];

        try {
            const query = keywordsCol
                .where('channelName', '==', channelName.toLowerCase())
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
            if (error.code === 5 && error.message.includes('index')) {
                logger.warn({ channel: channelName, error: error.message }, `[RiddleStorage] Firestore index likely missing for getRecentKeywords query.`);
                const fallbackQuery = keywordsCol
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
                    logger.debug(`[RiddleStorage] Retrieved ${recentKeywordSets.length} keyword sets (fallback) for channel ${channelName}.`);
                    return recentKeywordSets;
                } catch (fallbackError) {
                    logger.error({ err: fallbackError, channel: channelName }, `[RiddleStorage] Error with fallback query for recent keywords.`);
                    throw new StorageError(`Failed to get recent keywords for ${channelName} (fallback error)`, fallbackError);
                }
            }
            logger.error({ err: error, channel: channelName }, `[RiddleStorage] Error getting recent keywords`);
            throw new StorageError(`Failed to get recent keywords for ${channelName}`, error);
        }
    }

    async pruneOldKeywords(channelName) {
        const db = this._getDb();
        const keywordsCol = db.collection(RECENT_KEYWORDS_COLLECTION);
        const cutoffDate = Timestamp.fromDate(new Date(Date.now() - RECENT_KEYWORDS_TTL_DAYS * 24 * 60 * 60 * 1000));
        let deletedCount = 0;

        try {
            const snapshot = await keywordsCol
                .where('channelName', '==', channelName.toLowerCase())
                .where('createdAt', '<', cutoffDate)
                .limit(500)
                .get();

            if (snapshot.empty) {
                logger.debug(`[RiddleStorage] No old keywords to prune for channel ${channelName}.`);
                return 0;
            }

            const batch = db.batch();
            snapshot.docs.forEach(doc => {
                batch.delete(doc.ref);
                deletedCount++;
            });
            await batch.commit();
            logger.info(`[RiddleStorage] Pruned ${deletedCount} old keyword sets for channel ${channelName}.`);
            return deletedCount;
        } catch (error) {
            logger.error({ err: error, channel: channelName }, `[RiddleStorage] Error pruning old keywords.`);
            throw new StorageError(`Failed to prune old keywords for ${channelName}`, error);
        }
    }

    // --- Recent Riddle Answers ---

    async saveRecentAnswer(channelName, answer) {
        if (!answer || typeof answer !== 'string' || answer.trim() === '') {
            logger.warn(`[RiddleStorage] Attempted to save empty or invalid answer for channel ${channelName}. Skipping.`);
            return;
        }
        const db = this._getDb();
        const answersCol = db.collection(RECENT_ANSWERS_COLLECTION);
        const dataToSave = {
            channelName: channelName.toLowerCase(),
            answer: answer.toLowerCase().trim(),
            createdAt: FieldValue.serverTimestamp()
        };
        try {
            await answersCol.add(dataToSave);
            logger.debug(`[RiddleStorage] Saved recent answer for channel ${channelName}: ${answer}`);
        } catch (error) {
            logger.error({ err: error, channel: channelName, answer }, `[RiddleStorage] Error saving recent answer`);
            // Don't throw, not critical if this fails
        }
    }

    async getRecentAnswers(channelName, limit = 15) {
        const db = this._getDb();
        const answersCol = db.collection(RECENT_ANSWERS_COLLECTION);
        const recentAnswers = new Set();

        try {
            const query = answersCol
                .where('channelName', '==', channelName.toLowerCase())
                .orderBy('createdAt', 'desc')
                .limit(limit * 2);

            const snapshot = await query.get();
            snapshot.forEach(doc => {
                const data = doc.data();
                if (data.answer) {
                    recentAnswers.add(data.answer);
                }
            });
            const limitedRecentAnswers = Array.from(recentAnswers).slice(0, limit);
            logger.debug(`[RiddleStorage] Retrieved ${limitedRecentAnswers.length} unique recent answers for channel ${channelName}.`);
            return limitedRecentAnswers;
        } catch (error) {
            if (error.code === 5 && error.message.includes('index')) {
                logger.warn(`[RiddleStorage] Index missing for getRecentAnswers.`);
            }
            logger.error({ err: error, channel: channelName }, `[RiddleStorage] Error getting recent answers`);
            return [];
        }
    }
}

// ── Singleton instance ─────────────────────────────────────────────

const riddleStorage = new RiddleStorage();

// ── Backward-compatible named exports ──────────────────────────────
// Aliases map old function names to new canonical method names.

const initializeRiddleStorage = () => riddleStorage.initializeStorage();
const loadChannelRiddleConfig = (channelName) => riddleStorage.loadChannelConfig(channelName);
const saveChannelRiddleConfig = (channelName, config) => riddleStorage.saveChannelConfig(channelName, config);
const updatePlayerScore = (username, channelName, points, displayName) => riddleStorage.updatePlayerScore(username, channelName, points, displayName);
const getLeaderboard = (channelName, limit) => riddleStorage.getLeaderboard(channelName, limit);
const clearLeaderboardData = (channelName) => riddleStorage.clearChannelLeaderboardData(channelName);
const getLatestCompletedSessionInfo = (channelName) => riddleStorage.getLatestCompletedSessionInfo(channelName);
const flagRiddleAsProblem = (riddleDocId, reason, reportedBy) => riddleStorage.flagHistoryEntryByDocId(riddleDocId, reason, reportedBy);
const recordRiddleResult = (details) => riddleStorage.recordRiddleResult(details);
const getMostRecentRiddlePlayed = (channelName) => riddleStorage.getMostRecentRiddlePlayed(channelName);
const saveRiddleKeywords = (channelName, keywords) => riddleStorage.saveRiddleKeywords(channelName, keywords);
const getRecentKeywords = (channelName, limit) => riddleStorage.getRecentKeywords(channelName, limit);
const pruneOldKeywords = (channelName) => riddleStorage.pruneOldKeywords(channelName);
const saveRecentAnswer = (channelName, answer) => riddleStorage.saveRecentAnswer(channelName, answer);
const getRecentAnswers = (channelName, limit) => riddleStorage.getRecentAnswers(channelName, limit);

export {
    initializeRiddleStorage,
    loadChannelRiddleConfig,
    saveChannelRiddleConfig,
    updatePlayerScore,
    getLeaderboard,
    clearLeaderboardData,
    getLatestCompletedSessionInfo,
    flagRiddleAsProblem,
    recordRiddleResult,
    getMostRecentRiddlePlayed,
    saveRiddleKeywords,
    getRecentKeywords,
    pruneOldKeywords,
    saveRecentAnswer,
    getRecentAnswers
};