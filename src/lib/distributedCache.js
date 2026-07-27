import { getFirestore } from './firestore.js';
import logger from './logger.js';
import { FieldValue } from '@google-cloud/firestore';

const DEDUP_COLLECTION = 'processedEvents';
const TEN_MINUTES_MS = 10 * 60 * 1000;

/**
 * Distributed deduplication using Firestore.
 * Useful for ensuring idempotency across multiple Cloud Run instances.
 * @param {string} key - Unique identifier for the event (e.g. messageId or custom key)
 * @param {string|number} timestamp - Timestamp of the event to check against staleness
 * @param {number} ttlMs - Cooldown/TTL in milliseconds (defaults to 10 minutes)
 * @returns {Promise<boolean>} True if the event is a duplicate and should be dropped.
 */
export async function isDuplicateEvent(key, timestamp, ttlMs = TEN_MINUTES_MS) {
    if (!key) return false;
    
    // Check staleness (replay guard)
    if (timestamp) {
        const nowTs = Date.now();
        const msgTs = typeof timestamp === 'string' ? Date.parse(timestamp) : timestamp;
        if (Number.isFinite(msgTs) && (nowTs - msgTs) > ttlMs) {
            logger.warn({ key, timestamp }, '[DistributedCache] Dropping event older than TTL (replay guard)');
            return true; // Too old, treat as duplicate/ignore
        }
    }

    try {
        const db = getFirestore();
        const docRef = db.collection(DEDUP_COLLECTION).doc(key);
        
        // Attempt to create the document. If it already exists, this transaction/write fails or we detect it.
        // The most robust way in Firestore without transactions is to use a condition or transaction, 
        // but simple `create` works perfectly: it throws ALREADY_EXISTS if the doc exists.
        await docRef.create({
            createdAt: FieldValue.serverTimestamp(),
            expiresAt: new Date(Date.now() + ttlMs)
        });
        
        // If create succeeds, it's not a duplicate.
        return false;
    } catch (error) {
        if (error.code === 6) { // ALREADY_EXISTS
            return true;
        }
        logger.error({ err: error, key }, '[DistributedCache] Error checking deduplication');
        // Fail open if Firestore is down, to not drop legitimate events
        return false;
    }
}
