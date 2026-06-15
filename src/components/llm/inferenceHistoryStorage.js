// src/components/llm/inferenceHistoryStorage.js
// Stores recent LLM responses per (channel, source) in Firestore so subsequent
// prompts can include them as "do not repeat" context.
// Documents auto-delete after 14 days via Firestore TTL on the `expiresAt` field.
//
// Setup TTL (run once after first deploy):
//   gcloud firestore fields ttls update expiresAt \
//     --collection-group=responses \
//     --project=streamsage-bot
//
// Composite index required (create via console or gcloud):
//   Collection group: responses
//   Fields: source ASC, createdAt DESC

import { getFirestore, Timestamp, createExpiresAt } from '../../lib/firestore.js';
import logger from '../../lib/logger.js';

const INFERENCE_HISTORY_COLLECTION = 'inferenceHistory';
const TTL_DAYS = 14;
const DEFAULT_LIMIT = 5;

// ─── Source key constants ───────────────────────────────────────────────────
// All source identifiers live here so callers never hard-code strings that
// must match between reads and writes.

/** Source key for daily check-in responses. */
export const CHECKIN_SOURCE = 'checkin';

/**
 * Returns the source key for a custom command by name.
 * @param {string} commandName - The command name (without '!').
 * @returns {string} Source key, e.g. "custom:hug".
 */
export function customCommandSource(commandName) {
    return `custom:${commandName}`;
}

// ─── Firestore I/O ──────────────────────────────────────────────────────────

/**
 * Log an LLM inference response to Firestore.
 * Fire-and-forget — errors are logged but never thrown.
 *
 * @param {string} channel - Channel name (without '#').
 * @param {string} source - Source identifier (use CHECKIN_SOURCE or customCommandSource()).
 * @param {string} response - The LLM's response text.
 */
export async function logInference(channel, source, response) {
    try {
        const db = getFirestore();
        const expiresAt = createExpiresAt(TTL_DAYS);

        const doc = {
            source,
            response,
            createdAt: Timestamp.fromDate(new Date()),
            expiresAt: Timestamp.fromDate(expiresAt),
        };

        await db.collection(INFERENCE_HISTORY_COLLECTION)
            .doc(channel)
            .collection('responses')
            .add(doc);

        logger.debug({ channel, source }, '[InferenceHistory] Inference logged.');
    } catch (err) {
        logger.warn({ err, channel, source }, '[InferenceHistory] Failed to log inference.');
    }
}

/**
 * Retrieve the most recent LLM responses for a given (channel, source) pair.
 * Returns an array of response strings, newest first.
 *
 * @param {string} channel - Channel name (without '#').
 * @param {string} source - Source identifier (use CHECKIN_SOURCE or customCommandSource()).
 * @param {number} [limit=5] - Maximum number of responses to return.
 * @returns {Promise<string[]>} Array of recent response texts (newest first).
 */
export async function getRecentInferences(channel, source, limit = DEFAULT_LIMIT) {
    try {
        const db = getFirestore();
        const snapshot = await db.collection(INFERENCE_HISTORY_COLLECTION)
            .doc(channel)
            .collection('responses')
            .where('source', '==', source)
            .orderBy('createdAt', 'desc')
            .limit(limit)
            .get();

        const responses = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.response) {
                responses.push(data.response);
            }
        });

        logger.debug({ channel, source, count: responses.length }, '[InferenceHistory] Retrieved recent inferences.');
        return responses;
    } catch (err) {
        logger.warn({ err, channel, source }, '[InferenceHistory] Failed to retrieve recent inferences.');
        return [];
    }
}
