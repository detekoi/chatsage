// src/components/context/channelCommandsStorage.js
import { Firestore, FieldValue } from '@google-cloud/firestore';
import logger from '../../lib/logger.js';

// --- Firestore Client Initialization ---
let db = null; // Firestore database instance

// Collection name for storing per-channel command settings
const CHANNEL_COMMANDS_COLLECTION = 'channelCommands';

/**
 * Custom error class for channel commands storage operations.
 */
export class ChannelCommandsStorageError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'ChannelCommandsStorageError';
        this.cause = cause;
    }
}

/**
 * Initializes the Google Cloud Firestore client for channel commands storage.
 * Relies on Application Default Credentials or GOOGLE_APPLICATION_CREDENTIALS environment variable.
 */
export async function initializeChannelCommandsStorage() {
    logger.info("[ChannelCommandsStorage] Initializing Google Cloud Firestore client...");
    try {
        logger.debug("[ChannelCommandsStorage] Creating new Firestore client instance...");
        
        // Create a new client
        db = new Firestore();
        
        logger.debug("[ChannelCommandsStorage] Firestore client created, testing connection...");
        
        // Test connection by fetching a document
        const testQuery = db.collection(CHANNEL_COMMANDS_COLLECTION).limit(1);
        logger.debug("[ChannelCommandsStorage] Executing test query...");
        const result = await testQuery.get();
        
        logger.debug(`[ChannelCommandsStorage] Test query successful. Found ${result.size} documents.`);
        logger.info("[ChannelCommandsStorage] Google Cloud Firestore client initialized and connected.");
    } catch (error) {
        logger.error({ 
            err: error, 
            message: error.message,
            code: error.code,
            stack: error.stack,
            projectId: process.env.GOOGLE_CLOUD_PROJECT || 'unknown'
        }, "[ChannelCommandsStorage] CRITICAL: Failed to initialize Google Cloud Firestore. Check credentials (GOOGLE_APPLICATION_CREDENTIALS).");
        
        // Log credential path if set
        const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        if (credPath) {
            logger.error(`[ChannelCommandsStorage] GOOGLE_APPLICATION_CREDENTIALS is set to: ${credPath}`);
        } else {
            logger.error("[ChannelCommandsStorage] GOOGLE_APPLICATION_CREDENTIALS environment variable is not set.");
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
        throw new Error("[ChannelCommandsStorage] Storage not initialized. Call initializeChannelCommandsStorage first.");
    }
    return db;
}

/**
 * Loads the disabled commands list for a specific channel from Firestore.
 * @param {string} channelName - The channel name (lowercase).
 * @returns {Promise<string[]>} Array of disabled command names, or empty array if not found.
 */
export async function getDisabledCommands(channelName) {
    const db = _getDb();
    const docRef = db.collection(CHANNEL_COMMANDS_COLLECTION).doc(channelName.toLowerCase());
    
    try {
        const docSnap = await docRef.get();
        if (docSnap.exists) {
            const data = docSnap.data();
            const disabledCommands = data.disabledCommands || [];
            logger.debug(`[ChannelCommandsStorage] Loaded ${disabledCommands.length} disabled commands for channel ${channelName}: [${disabledCommands.join(', ')}]`);
            return disabledCommands;
        } else {
            logger.debug(`[ChannelCommandsStorage] No command settings found for channel ${channelName}, all commands enabled by default`);
            return []; // All commands enabled by default
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `[ChannelCommandsStorage] Error loading disabled commands for channel ${channelName}`);
        throw new ChannelCommandsStorageError(`Failed to load disabled commands for ${channelName}`, error);
    }
}

/**
 * Disables a command for a specific channel by adding it to the disabledCommands array.
 * @param {string} channelName - The channel name (lowercase).
 * @param {string} commandName - The command name to disable.
 * @returns {Promise<boolean>} True if command was newly disabled, false if already disabled.
 */
export async function disableCommand(channelName, commandName) {
    const db = _getDb();
    const docRef = db.collection(CHANNEL_COMMANDS_COLLECTION).doc(channelName.toLowerCase());
    
    try {
        // First check if it's already disabled
        const currentDisabled = await getDisabledCommands(channelName);
        if (currentDisabled.includes(commandName)) {
            logger.debug(`[ChannelCommandsStorage] Command ${commandName} already disabled in channel ${channelName}`);
            return false;
        }
        
        // Add to disabled list using atomic array union
        await docRef.set({
            channelName: channelName.toLowerCase(),
            disabledCommands: FieldValue.arrayUnion(commandName),
            updatedAt: new Date()
        }, { merge: true });
        
        logger.info(`[ChannelCommandsStorage] Disabled command ${commandName} for channel ${channelName}`);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, command: commandName }, 
            `[ChannelCommandsStorage] Error disabling command ${commandName} for channel ${channelName}`);
        throw new ChannelCommandsStorageError(`Failed to disable command ${commandName} for ${channelName}`, error);
    }
}

/**
 * Enables a command for a specific channel by removing it from the disabledCommands array.
 * @param {string} channelName - The channel name (lowercase).
 * @param {string} commandName - The command name to enable.
 * @returns {Promise<boolean>} True if command was newly enabled, false if already enabled.
 */
export async function enableCommand(channelName, commandName) {
    const db = _getDb();
    const docRef = db.collection(CHANNEL_COMMANDS_COLLECTION).doc(channelName.toLowerCase());
    
    try {
        // First check if it's currently disabled
        const currentDisabled = await getDisabledCommands(channelName);
        if (!currentDisabled.includes(commandName)) {
            logger.debug(`[ChannelCommandsStorage] Command ${commandName} already enabled in channel ${channelName}`);
            return false;
        }
        
        // Remove from disabled list using atomic array remove
        await docRef.set({
            channelName: channelName.toLowerCase(),
            disabledCommands: FieldValue.arrayRemove(commandName),
            updatedAt: new Date()
        }, { merge: true });
        
        logger.info(`[ChannelCommandsStorage] Enabled command ${commandName} for channel ${channelName}`);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, command: commandName }, 
            `[ChannelCommandsStorage] Error enabling command ${commandName} for channel ${channelName}`);
        throw new ChannelCommandsStorageError(`Failed to enable command ${commandName} for ${channelName}`, error);
    }
}

/**
 * Loads all channel command settings from Firestore.
 * @returns {Promise<Map<string, Set<string>>>} Map of channel names to Set of disabled command names.
 */
export async function loadAllChannelCommandSettings() {
    const db = _getDb();
    const colRef = db.collection(CHANNEL_COMMANDS_COLLECTION);
    
    try {
        const snapshot = await colRef.get();
        const channelSettings = new Map();
        
        snapshot.forEach(doc => {
            const data = doc.data();
            const channelName = data.channelName;
            const disabledCommands = new Set(data.disabledCommands || []);
            channelSettings.set(channelName, disabledCommands);
        });
        
        logger.info(`[ChannelCommandsStorage] Loaded command settings for ${channelSettings.size} channels`);
        return channelSettings;
    } catch (error) {
        logger.error({ err: error }, `[ChannelCommandsStorage] Error loading all channel command settings`);
        throw new ChannelCommandsStorageError('Failed to load all channel command settings', error);
    }
}

/**
 * Sets up a listener for changes to the channelCommands collection.
 * @param {Function} onChangeCallback - Callback function called when changes occur.
 *                                     Receives (channelName, disabledCommandsSet) parameters.
 * @returns {Function} Unsubscribe function to stop listening for changes.
 */
export function listenForCommandSettingsChanges(onChangeCallback) {
    const db = _getDb();
    
    logger.info("[ChannelCommandsStorage] Setting up listener for command settings changes...");
    
    const unsubscribe = db.collection(CHANNEL_COMMANDS_COLLECTION)
        .onSnapshot(snapshot => {
            snapshot.docChanges().forEach(change => {
                const channelData = change.doc.data();
                if (channelData && typeof channelData.channelName === 'string') {
                    const channelName = channelData.channelName;
                    const disabledCommands = new Set(channelData.disabledCommands || []);
                    
                    logger.debug(`[ChannelCommandsStorage] Command settings changed for channel ${channelName}, disabled commands: [${Array.from(disabledCommands).join(', ')}]`);
                    onChangeCallback(channelName, disabledCommands);
                } else {
                    logger.warn({ docId: change.doc.id }, 
                        `[ChannelCommandsStorage] Firestore listener detected change in document missing valid 'channelName'. Skipping.`);
                }
            });
        }, error => {
            logger.error({ err: error }, "[ChannelCommandsStorage] Error in command settings listener.");
        });
    
    logger.info("[ChannelCommandsStorage] Command settings listener set up successfully.");
    
    return unsubscribe;
}