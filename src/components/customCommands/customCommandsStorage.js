// src/components/customCommands/customCommandsStorage.js
import { Firestore, FieldValue } from '@google-cloud/firestore';
import logger from '../../lib/logger.js';

// --- Firestore Client Initialization ---
let db = null;

// Collection name for storing per-channel custom commands
const CUSTOM_COMMANDS_COLLECTION = 'customCommands';

/**
 * Custom error class for custom commands storage operations.
 */
export class CustomCommandsStorageError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'CustomCommandsStorageError';
        this.cause = cause;
    }
}

/**
 * Initializes the Google Cloud Firestore client for custom commands storage.
 */
export async function initializeCustomCommandsStorage() {
    logger.info('[CustomCommandsStorage] Initializing Google Cloud Firestore client...');
    try {
        db = new Firestore();

        // Test connection
        const testQuery = db.collection(CUSTOM_COMMANDS_COLLECTION).limit(1);
        await testQuery.get();

        logger.info('[CustomCommandsStorage] Firestore client initialized and connected.');
    } catch (error) {
        logger.error({
            err: error,
            message: error.message,
            code: error.code,
        }, '[CustomCommandsStorage] CRITICAL: Failed to initialize Firestore.');
        throw error;
    }
}

/**
 * Gets the Firestore database instance.
 * @returns {Firestore} Firestore DB instance.
 */
function _getDb() {
    if (!db) {
        throw new Error('[CustomCommandsStorage] Storage not initialized. Call initializeCustomCommandsStorage first.');
    }
    return db;
}

/**
 * Gets a single custom command for a channel.
 * @param {string} channelName - The channel name (lowercase).
 * @param {string} commandName - The command name (lowercase, without !).
 * @returns {Promise<object|null>} Command data or null if not found.
 */
export async function getCustomCommand(channelName, commandName) {
    const db = _getDb();
    const docRef = db.collection(CUSTOM_COMMANDS_COLLECTION)
        .doc(channelName.toLowerCase())
        .collection('commands')
        .doc(commandName.toLowerCase());

    try {
        const docSnap = await docRef.get();
        if (docSnap.exists) {
            return { name: commandName.toLowerCase(), ...docSnap.data() };
        }
        return null;
    } catch (error) {
        logger.error({ err: error, channel: channelName, command: commandName },
            '[CustomCommandsStorage] Error getting custom command');
        throw new CustomCommandsStorageError(`Failed to get custom command ${commandName} for ${channelName}`, error);
    }
}

/**
 * Gets all custom commands for a channel.
 * @param {string} channelName - The channel name (lowercase).
 * @returns {Promise<object[]>} Array of command objects.
 */
export async function getAllCustomCommands(channelName) {
    const db = _getDb();
    const colRef = db.collection(CUSTOM_COMMANDS_COLLECTION)
        .doc(channelName.toLowerCase())
        .collection('commands');

    try {
        const snapshot = await colRef.get();
        const commands = [];
        snapshot.forEach(doc => {
            commands.push({ name: doc.id, ...doc.data() });
        });
        logger.debug(`[CustomCommandsStorage] Loaded ${commands.length} custom commands for channel ${channelName}`);
        return commands;
    } catch (error) {
        logger.error({ err: error, channel: channelName },
            '[CustomCommandsStorage] Error loading custom commands');
        throw new CustomCommandsStorageError(`Failed to load custom commands for ${channelName}`, error);
    }
}

/**
 * Adds a new custom command for a channel.
 * @param {string} channelName - The channel name (lowercase).
 * @param {string} commandName - The command name (lowercase, without !).
 * @param {string} response - The command response template.
 * @param {string} createdBy - Username of the creator.
 * @returns {Promise<boolean>} True if created, false if command already exists.
 */
export async function addCustomCommand(channelName, commandName, response, createdBy) {
    const db = _getDb();
    const lowerChannel = channelName.toLowerCase();
    const lowerCommand = commandName.toLowerCase();

    const docRef = db.collection(CUSTOM_COMMANDS_COLLECTION)
        .doc(lowerChannel)
        .collection('commands')
        .doc(lowerCommand);

    try {
        // Check if command already exists
        const existing = await docRef.get();
        if (existing.exists) {
            logger.debug(`[CustomCommandsStorage] Command ${lowerCommand} already exists in channel ${lowerChannel}`);
            return false;
        }

        await docRef.set({
            response,
            permission: 'everyone',
            cooldownMs: 0,
            useCount: 0,
            createdBy: createdBy.toLowerCase(),
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
        });

        // Also set the parent doc to ensure it exists for queries
        await db.collection(CUSTOM_COMMANDS_COLLECTION)
            .doc(lowerChannel)
            .set({ channelName: lowerChannel, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

        logger.info(`[CustomCommandsStorage] Added custom command !${lowerCommand} for channel ${lowerChannel}`);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: lowerChannel, command: lowerCommand },
            '[CustomCommandsStorage] Error adding custom command');
        throw new CustomCommandsStorageError(`Failed to add custom command ${lowerCommand} for ${lowerChannel}`, error);
    }
}

/**
 * Updates an existing custom command's response.
 * @param {string} channelName - The channel name (lowercase).
 * @param {string} commandName - The command name (lowercase, without !).
 * @param {string} response - The new response template.
 * @returns {Promise<boolean>} True if updated, false if command doesn't exist.
 */
export async function updateCustomCommand(channelName, commandName, response) {
    const db = _getDb();
    const lowerChannel = channelName.toLowerCase();
    const lowerCommand = commandName.toLowerCase();

    const docRef = db.collection(CUSTOM_COMMANDS_COLLECTION)
        .doc(lowerChannel)
        .collection('commands')
        .doc(lowerCommand);

    try {
        const existing = await docRef.get();
        if (!existing.exists) {
            return false;
        }

        await docRef.update({
            response,
            updatedAt: FieldValue.serverTimestamp(),
        });

        logger.info(`[CustomCommandsStorage] Updated custom command !${lowerCommand} for channel ${lowerChannel}`);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: lowerChannel, command: lowerCommand },
            '[CustomCommandsStorage] Error updating custom command');
        throw new CustomCommandsStorageError(`Failed to update custom command ${lowerCommand} for ${lowerChannel}`, error);
    }
}

/**
 * Updates options (permission, cooldown) for a custom command.
 * @param {string} channelName - The channel name.
 * @param {string} commandName - The command name.
 * @param {object} options - Options to update.
 * @param {string} [options.permission] - Permission level.
 * @param {number} [options.cooldownMs] - Cooldown in milliseconds.
 * @returns {Promise<boolean>} True if updated, false if command doesn't exist.
 */
export async function updateCustomCommandOptions(channelName, commandName, options) {
    const db = _getDb();
    const lowerChannel = channelName.toLowerCase();
    const lowerCommand = commandName.toLowerCase();

    const docRef = db.collection(CUSTOM_COMMANDS_COLLECTION)
        .doc(lowerChannel)
        .collection('commands')
        .doc(lowerCommand);

    try {
        const existing = await docRef.get();
        if (!existing.exists) {
            return false;
        }

        const updateData = { updatedAt: FieldValue.serverTimestamp() };
        if (options.permission !== undefined) {
            updateData.permission = options.permission;
        }
        if (options.cooldownMs !== undefined) {
            updateData.cooldownMs = options.cooldownMs;
        }

        await docRef.update(updateData);

        logger.info(`[CustomCommandsStorage] Updated options for !${lowerCommand} in ${lowerChannel}: ${JSON.stringify(options)}`);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: lowerChannel, command: lowerCommand },
            '[CustomCommandsStorage] Error updating command options');
        throw new CustomCommandsStorageError(`Failed to update options for ${lowerCommand} in ${lowerChannel}`, error);
    }
}

/**
 * Removes a custom command from a channel.
 * @param {string} channelName - The channel name (lowercase).
 * @param {string} commandName - The command name (lowercase, without !).
 * @returns {Promise<boolean>} True if removed, false if command didn't exist.
 */
export async function removeCustomCommand(channelName, commandName) {
    const db = _getDb();
    const lowerChannel = channelName.toLowerCase();
    const lowerCommand = commandName.toLowerCase();

    const docRef = db.collection(CUSTOM_COMMANDS_COLLECTION)
        .doc(lowerChannel)
        .collection('commands')
        .doc(lowerCommand);

    try {
        const existing = await docRef.get();
        if (!existing.exists) {
            return false;
        }

        await docRef.delete();

        logger.info(`[CustomCommandsStorage] Removed custom command !${lowerCommand} from channel ${lowerChannel}`);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: lowerChannel, command: lowerCommand },
            '[CustomCommandsStorage] Error removing custom command');
        throw new CustomCommandsStorageError(`Failed to remove custom command ${lowerCommand} from ${lowerChannel}`, error);
    }
}

/**
 * Increments the use count for a custom command.
 * @param {string} channelName - The channel name.
 * @param {string} commandName - The command name.
 * @returns {Promise<number>} The new use count.
 */
export async function incrementUseCount(channelName, commandName) {
    const db = _getDb();
    const docRef = db.collection(CUSTOM_COMMANDS_COLLECTION)
        .doc(channelName.toLowerCase())
        .collection('commands')
        .doc(commandName.toLowerCase());

    try {
        await docRef.update({
            useCount: FieldValue.increment(1),
        });

        // Read back the new count
        const updated = await docRef.get();
        return updated.data()?.useCount || 0;
    } catch (error) {
        logger.error({ err: error, channel: channelName, command: commandName },
            '[CustomCommandsStorage] Error incrementing use count');
        // Non-fatal — don't throw, just return 0
        return 0;
    }
}

/**
 * Loads all custom commands for all channels.
 * Used for in-memory cache initialization.
 * @returns {Promise<Map<string, Map<string, object>>>} Map of channelName -> Map of commandName -> command data.
 */
export async function loadAllCustomCommands() {
    const db = _getDb();
    const colRef = db.collection(CUSTOM_COMMANDS_COLLECTION);

    try {
        const channelSnapshot = await colRef.get();
        const allCommands = new Map();

        for (const channelDoc of channelSnapshot.docs) {
            const channelName = channelDoc.id;
            const commandsSnapshot = await channelDoc.ref.collection('commands').get();
            const channelCommands = new Map();

            commandsSnapshot.forEach(doc => {
                channelCommands.set(doc.id, { name: doc.id, ...doc.data() });
            });

            if (channelCommands.size > 0) {
                allCommands.set(channelName, channelCommands);
            }
        }

        logger.info(`[CustomCommandsStorage] Loaded custom commands for ${allCommands.size} channels`);
        return allCommands;
    } catch (error) {
        logger.error({ err: error }, '[CustomCommandsStorage] Error loading all custom commands');
        throw new CustomCommandsStorageError('Failed to load all custom commands', error);
    }
}
