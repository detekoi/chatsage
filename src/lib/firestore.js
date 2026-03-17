// src/lib/firestore.js
// Centralized Firestore client. All storage modules import from here
// instead of each creating their own `new Firestore()` instance.
import { Firestore, FieldValue, Timestamp } from '@google-cloud/firestore';
import logger from './logger.js';

/** @type {Firestore|null} */
let _db = null;

/**
 * Initializes the shared Firestore client and verifies connectivity.
 * Call this once during app startup (from initComponents.js) before any
 * storage module is used.
 *
 * @returns {Promise<void>}
 * @throws {Error} If Firestore cannot be initialized or connectivity check fails.
 */
export async function initializeFirestore() {
    if (_db) {
        logger.info('[Firestore] Client already initialized – skipping.');
        return;
    }

    logger.info('[Firestore] Initializing shared Firestore client...');
    try {
        logger.debug('[Firestore] Creating Firestore client instance...');
        _db = new Firestore();

        logger.debug('[Firestore] Running connectivity test...');
        // A lightweight test query confirms credentials and network are reachable.
        const testSnap = await _db.collection('_healthcheck').limit(1).get();
        logger.debug(`[Firestore] Connectivity test OK (${testSnap.size} docs in _healthcheck).`);
        logger.info('[Firestore] Shared Firestore client initialized and connected.');
    } catch (error) {
        logger.fatal({
            err: error,
            message: error.message,
            code: error.code,
            projectId: process.env.GOOGLE_CLOUD_PROJECT || 'unknown',
        }, '[Firestore] CRITICAL: Failed to initialize Firestore. Check credentials (GOOGLE_APPLICATION_CREDENTIALS).');

        const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        if (credPath) {
            logger.fatal(`[Firestore] GOOGLE_APPLICATION_CREDENTIALS = ${credPath}`);
        } else {
            logger.fatal('[Firestore] GOOGLE_APPLICATION_CREDENTIALS is not set. Using Application Default Credentials.');
        }

        _db = null;
        throw error;
    }
}

/**
 * Returns the initialized Firestore instance.
 * Throws immediately if `initializeFirestore()` has not been called yet.
 *
 * @returns {Firestore}
 * @throws {Error} If Firestore has not been initialized.
 */
export function getFirestore() {
    if (!_db) {
        throw new Error(
            '[Firestore] Not initialized. Call initializeFirestore() before using storage modules.'
        );
    }
    return _db;
}

// Re-export commonly used Firestore types so storage modules only need
// to import from this file, not from @google-cloud/firestore directly.
export { FieldValue, Timestamp };
