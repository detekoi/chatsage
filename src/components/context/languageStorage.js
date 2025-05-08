// src/components/context/languageStorage.js
import { Firestore } from '@google-cloud/firestore';
import logger from '../../lib/logger.js';

// --- Firestore Client Initialization ---
let db = null; // Firestore database instance

// Collection name
const LANGUAGE_COLLECTION = 'channelLanguages';

/**
 * Custom error class for language storage operations.
 */
export class LanguageStorageError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'LanguageStorageError';
        this.cause = cause;
    }
}

/**
 * Initializes the Google Cloud Firestore client for language storage.
 * Relies on Application Default Credentials or GOOGLE_APPLICATION_CREDENTIALS environment variable.
 */
export async function initializeLanguageStorage() {
    logger.info("[LanguageStorage] Initializing Google Cloud Firestore client...");
    try {
        // Log before creating client - will help identify if constructor fails
        logger.debug("[LanguageStorage] Creating new Firestore client instance...");
        
        // Create a new client
        db = new Firestore();
        
        logger.debug("[LanguageStorage] Firestore client created, testing connection...");
        
        // Test connection by fetching a document
        const testQuery = db.collection(LANGUAGE_COLLECTION).limit(1);
        logger.debug("[LanguageStorage] Executing test query...");
        const result = await testQuery.get();
        
        logger.debug(`[LanguageStorage] Test query successful. Found ${result.size} documents.`);
        logger.info("[LanguageStorage] Google Cloud Firestore client initialized and connected.");
    } catch (error) {
        logger.error({ 
            err: error, 
            message: error.message,
            code: error.code,
            stack: error.stack,
            projectId: process.env.GOOGLE_CLOUD_PROJECT || 'unknown'
        }, "[LanguageStorage] CRITICAL: Failed to initialize Google Cloud Firestore. Check credentials (GOOGLE_APPLICATION_CREDENTIALS).");
        
        // Log credential path if set
        const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        if (credPath) {
            logger.error(`[LanguageStorage] GOOGLE_APPLICATION_CREDENTIALS is set to: ${credPath}`);
        } else {
            logger.error("[LanguageStorage] GOOGLE_APPLICATION_CREDENTIALS environment variable is not set.");
        }
        
        // Rethrow error to let the caller handle it
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
        throw new Error("[LanguageStorage] Storage not initialized. Call initializeLanguageStorage first.");
    }
    return db;
}

/**
 * Loads the language setting for a specific channel from Firestore.
 * @param {string} channelName
 * @returns {Promise<string|null>} The language setting or null if not found/default.
 */
export async function getChannelLanguage(channelName) {
    const db = _getDb();
    const docRef = db.collection(LANGUAGE_COLLECTION).doc(channelName.toLowerCase());
    try {
        const docSnap = await docRef.get();
        if (docSnap.exists) {
            const data = docSnap.data();
            logger.debug(`[LanguageStorage] Loaded language setting for channel ${channelName}: ${data.language || 'default'}`);
            return data.language; // Can be null for default
        } else {
            logger.debug(`[LanguageStorage] No language setting found for channel ${channelName}, using default`);
            return null; // Not found is not an error
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `[LanguageStorage] Error loading language setting for channel ${channelName}`);
        throw new LanguageStorageError(`Failed to load language setting for ${channelName}`, error);
    }
}

/**
 * Saves or updates the language setting for a specific channel in Firestore.
 * @param {string} channelName
 * @param {string|null} language - The language to save (null for default English).
 * @returns {Promise<boolean>} True on success, false on failure.
 */
export async function saveChannelLanguage(channelName, language) {
    const db = _getDb();
    const docRef = db.collection(LANGUAGE_COLLECTION).doc(channelName.toLowerCase());
    try {
        await docRef.set({
            channelName: channelName.toLowerCase(),
            language: language,
            updatedAt: new Date()
        }, { merge: true });
        logger.debug(`[LanguageStorage] Saved language setting for channel ${channelName}: ${language || 'default'}`);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `[LanguageStorage] Error saving language setting for channel ${channelName}`);
        throw new LanguageStorageError(`Failed to save language setting for ${channelName}`, error);
    }
}

/**
 * Loads all channel language settings from Firestore.
 * @returns {Promise<Map<string, string>>} Map of channel names to language settings.
 */
export async function loadAllChannelLanguages() {
    const db = _getDb();
    const colRef = db.collection(LANGUAGE_COLLECTION);
    try {
        const snapshot = await colRef.get();
        const channelLanguages = new Map();
        
        snapshot.forEach(doc => {
            const data = doc.data();
            channelLanguages.set(data.channelName, data.language);
        });
        
        logger.info(`[LanguageStorage] Loaded language settings for ${channelLanguages.size} channels`);
        return channelLanguages;
    } catch (error) {
        logger.error({ err: error }, `[LanguageStorage] Error loading all channel language settings`);
        throw new LanguageStorageError('Failed to load all channel language settings', error);
    }
}
