import { getFirestore } from './firestore.js';
import logger from './logger.js';
import { FieldValue } from '@google-cloud/firestore';

const DEDUP_COLLECTION = 'processedEvents';
const TEN_MINUTES_MS = 10 * 60 * 1000;

/**
 * Distributed deduplication using Firestore.
 * Useful for ensuring idempotency across multiple Cloud Run instances.
 * @param {string} key - Unique identifier for the event (e.g. messageId or custom key)
 * @param {string|number|null} timestamp - Timestamp of the event to check against staleness (pass null to skip)
 * @param {number} ttlMs - Cooldown/TTL in milliseconds (defaults to 10 minutes)
 * @param {boolean} failOpen - If true, returns false (not duplicate) on Firestore errors. If false, fails closed (returns true).
 * @returns {Promise<boolean>} True if the event is a duplicate and should be dropped.
 */
export async function isDuplicateEvent(key, timestamp, ttlMs = TEN_MINUTES_MS, failOpen = true) {
    if (!key) return false;
    
    // Sanitize key for Firestore document ID
    const safeKey = String(key).replace(/\//g, '_');
    
    // Check staleness (replay guard)
    if (timestamp !== null && timestamp !== undefined) {
        const nowTs = Date.now();
        const msgTs = typeof timestamp === 'string' ? Date.parse(timestamp) : timestamp;
        if (Number.isFinite(msgTs) && (nowTs - msgTs) > ttlMs) {
            logger.warn({ key, timestamp }, '[DistributedCache] Dropping event older than TTL (replay guard)');
            return true; // Too old, treat as duplicate/ignore
        }
    }

    try {
        const db = getFirestore();
        const docRef = db.collection(DEDUP_COLLECTION).doc(safeKey);

        // Compare against expiresAt rather than treating the document's mere
        // existence as "still within the window". Firestore TTL deletion is
        // asynchronous and best-effort — a document can outlive its expiresAt by
        // hours. Reusable keys (command cooldowns, per-channel farewells) would
        // otherwise stay latched until the TTL sweep finally ran, turning a 30s
        // cooldown into a multi-hour one. TTL is storage reclamation only; the
        // window is enforced here.
        return await db.runTransaction(async (tx) => {
            const snapshot = await tx.get(docRef);
            const now = Date.now();

            if (snapshot.exists) {
                const expiresAt = snapshot.get('expiresAt');
                const expiresAtMs = typeof expiresAt?.toMillis === 'function'
                    ? expiresAt.toMillis()
                    : Number(expiresAt) || 0;

                if (expiresAtMs > now) {
                    return true; // Genuinely still inside the window.
                }
            }

            tx.set(docRef, {
                createdAt: FieldValue.serverTimestamp(),
                expiresAt: new Date(now + ttlMs)
            });
            return false;
        });
    } catch (error) {
        logger.error({ err: error, safeKey }, '[DistributedCache] Error checking deduplication');
        return !failOpen;
    }
}
