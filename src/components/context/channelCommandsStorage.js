// src/components/context/channelCommandsStorage.js
//
// Layout: channelCommands/{broadcasterId} -> { channelName, disabledCommands: string[],
//         commandOptions: { [command]: { [option]: value } } }
// Keyed by broadcaster ID, not login (see lib/channelKey.js). The web UI writes
// the same documents (chatsage-web-ui/functions/src/api/commands.router.ts).
import { getFirestore, FieldValue } from '../../lib/firestore.js';
import { channelDocKey, channelNameForDocKey } from '../../lib/channelKey.js';
import logger from '../../lib/logger.js';

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
 * No-op – Firestore is now initialized centrally via initializeFirestore() in initComponents.js.
 */
export async function initializeChannelCommandsStorage() {
    logger.debug('[ChannelCommandsStorage] Using shared Firestore client.');
}

/** @returns {import('@google-cloud/firestore').Firestore} */
function _getDb() {
    return getFirestore();
}

function _channelDocRef(channelName) {
    return _getDb().collection(CHANNEL_COMMANDS_COLLECTION).doc(channelDocKey(channelName));
}

// The dashboard options of every command in a channel document, keyed by lowercased command name.
// A value that is not a plain object is dropped, so a bad write reads as "no options".
function _extractCommandOptions(data) {
    const raw = data?.commandOptions;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
    }
    const cleaned = {};
    for (const [cmd, opts] of Object.entries(raw)) {
        if (opts && typeof opts === 'object' && !Array.isArray(opts)) {
            cleaned[cmd.toLowerCase()] = opts;
        }
    }
    return cleaned;
}

/**
 * Loads the disabled commands list for a specific channel from Firestore.
 * @param {string} channelName - The channel name (lowercase).
 * @returns {Promise<string[]>} Array of disabled command names, or empty array if not found.
 */
export async function getDisabledCommands(channelName) {
    try {
        const docSnap = await _channelDocRef(channelName).get();
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
    try {
        // First check if it's already disabled
        const currentDisabled = await getDisabledCommands(channelName);
        if (currentDisabled.includes(commandName)) {
            logger.debug(`[ChannelCommandsStorage] Command ${commandName} already disabled in channel ${channelName}`);
            return false;
        }
        
        // Add to disabled list using atomic array union
        await _channelDocRef(channelName).set({
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
    try {
        // First check if it's currently disabled
        const currentDisabled = await getDisabledCommands(channelName);
        if (!currentDisabled.includes(commandName)) {
            logger.debug(`[ChannelCommandsStorage] Command ${commandName} already enabled in channel ${channelName}`);
            return false;
        }
        
        // Remove from disabled list using atomic array remove
        await _channelDocRef(channelName).set({
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
 * @returns {Promise<{ disabledCommands: Map<string, Set<string>>, commandOptions: Map<string, object> }>}
 *   Per channel name: the disabled command names, and the dashboard options of each command.
 */
export async function loadAllChannelCommandSettings() {
    const db = _getDb();
    const colRef = db.collection(CHANNEL_COMMANDS_COLLECTION);
    
    try {
        const snapshot = await colRef.get();
        const disabledByChannel = new Map();
        const optionsByChannel = new Map();
        
        snapshot.forEach(doc => {
            const data = doc.data();
            const channelName = channelNameForDocKey(doc.id, data);
            if (!channelName) {
                logger.debug({ docId: doc.id }, '[ChannelCommandsStorage] Skipping command settings for an unknown channel');
                return;
            }
            disabledByChannel.set(channelName, new Set(data.disabledCommands || []));
            optionsByChannel.set(channelName, _extractCommandOptions(data));
        });
        
        logger.info(`[ChannelCommandsStorage] Loaded command settings for ${disabledByChannel.size} channels`);
        return { disabledCommands: disabledByChannel, commandOptions: optionsByChannel };
    } catch (error) {
        logger.error({ err: error }, `[ChannelCommandsStorage] Error loading all channel command settings`);
        throw new ChannelCommandsStorageError('Failed to load all channel command settings', error);
    }
}

/**
 * Sets up a listener for changes to the channelCommands collection.
 * @param {Function} onChangeCallback - Callback function called when changes occur.
 *                                     Receives (channelName, disabledCommandsSet, commandOptions) parameters.
 * @returns {Function} Unsubscribe function to stop listening for changes.
 */
export function listenForCommandSettingsChanges(onChangeCallback) {
    const db = _getDb();
    
    logger.info("[ChannelCommandsStorage] Setting up listener for command settings changes...");
    
    const unsubscribe = db.collection(CHANNEL_COMMANDS_COLLECTION)
        .onSnapshot(snapshot => {
            snapshot.docChanges().forEach(change => {
                const channelData = change.doc.data();
                const channelName = channelNameForDocKey(change.doc.id, channelData);
                if (channelName) {
                    // A removed document still reports its last data; the dashboard
                    // deleting the settings means "everything enabled", not "as before".
                    const disabledCommands = change.type === 'removed'
                        ? new Set()
                        : new Set(channelData?.disabledCommands || []);
                    const commandOptions = change.type === 'removed'
                        ? {}
                        : _extractCommandOptions(channelData);
                    
                    logger.debug(`[ChannelCommandsStorage] Command settings changed for channel ${channelName}, disabled commands: [${Array.from(disabledCommands).join(', ')}]`);
                    try {
                        onChangeCallback(channelName, disabledCommands, commandOptions);
                    } catch (err) {
                        logger.error({ err, channelName }, '[ChannelCommandsStorage] Command settings change callback failed');
                    }
                } else {
                    logger.debug({ docId: change.doc.id },
                        '[ChannelCommandsStorage] Firestore listener saw a change for an unknown channel. Skipping.');
                }
            });
        }, error => {
            logger.error({ err: error }, "[ChannelCommandsStorage] Error in command settings listener.");
        });
    
    logger.info("[ChannelCommandsStorage] Command settings listener set up successfully.");
    
    return unsubscribe;
}