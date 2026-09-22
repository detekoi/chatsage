// src/components/memory/memoryStorage.js
//
// Long-term channel memory: lore, in-jokes and light facts about regulars.
//
//   channelMemories/{broadcasterId}              -> { channelName, optedOut: string[], enabled, updatedAt }
//   channelMemories/{broadcasterId}/items/{id}   -> one memory (see addMemory)
//   channelMemoryPending/{broadcasterId}         -> raw chat lines stashed at shutdown, waiting for extraction
//
// Documents are keyed by broadcaster ID (see lib/channelKey.js), never by login: memory text is
// composed into prompts, so a renamed channel must keep it and the next owner of the freed name
// must not inherit it. `channelName` is stored for readability only.
//
// No TTL on any of these: memories are meant to outlive streams, and the pending doc is deleted
// by the next process that picks it up.
import { getFirestore, FieldValue } from '../../lib/firestore.js';
import { channelDocKey, normalizeChannelName } from '../../lib/channelKey.js';
import logger from '../../lib/logger.js';

const MEMORY_COLLECTION = 'channelMemories';
const ITEMS_SUBCOLLECTION = 'items';
const PENDING_COLLECTION = 'channelMemoryPending';

/**
 * Custom error class for memory storage operations.
 */
export class MemoryStorageError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'MemoryStorageError';
        this.cause = cause;
    }
}

/**
 * No-op – Firestore is now initialized centrally via initializeFirestore() in initComponents.js.
 */
export async function initializeMemoryStorage() {
    logger.debug('[MemoryStorage] Using shared Firestore client.');
}

/** @returns {import('@google-cloud/firestore').Firestore} */
function _getDb() {
    return getFirestore();
}

function _channelRef(channelName) {
    return _getDb().collection(MEMORY_COLLECTION).doc(channelDocKey(channelName));
}

function _pendingRef(channelName) {
    return _getDb().collection(PENDING_COLLECTION).doc(channelDocKey(channelName));
}

function _itemsRef(channelName) {
    return _channelRef(channelName).collection(ITEMS_SUBCOLLECTION);
}

/**
 * Loads every memory and the opt-out list for a channel.
 * @param {string} channelName
 * @returns {Promise<{memories: object[], optedOut: string[]}>}
 */
export async function loadChannelMemories(channelName) {
    try {
        const [parentSnap, itemsSnap] = await Promise.all([
            _channelRef(channelName).get(),
            _itemsRef(channelName).get(),
        ]);
        const memories = [];
        itemsSnap.forEach(doc => memories.push({ id: doc.id, ...doc.data() }));
        const parent = parentSnap.exists ? parentSnap.data() : {};
        const optedOut = parent.optedOut || [];
        // Opt-out: a channel that never touched the setting has memory on.
        const enabled = parent.enabled !== false;
        logger.debug(`[MemoryStorage] Loaded ${memories.length} memories for channel ${channelName}`);
        return { memories, optedOut, enabled };
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `[MemoryStorage] Error loading memories for channel ${channelName}`);
        throw new MemoryStorageError(`Failed to load memories for ${channelName}`, error);
    }
}

/**
 * Adds a memory.
 * @param {string} channelName
 * @param {{text: string, keys: string[], subjects: string[], kind: string, source: 'auto'|'manual', addedBy: string|null}} memory
 * @returns {Promise<object>} The stored memory including its id.
 */
export async function addMemory(channelName, memory) {
    const now = new Date();
    const doc = {
        text: memory.text,
        keys: memory.keys || [],
        subjects: memory.subjects || [],
        kind: memory.kind || 'other',
        source: memory.source || 'auto',
        addedBy: memory.addedBy || null,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
        mentions: 1,
        useCount: 0,
        lastUsedAt: null,
    };
    try {
        const ref = await _itemsRef(channelName).add(doc);
        return { id: ref.id, ...doc };
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `[MemoryStorage] Error adding memory for channel ${channelName}`);
        throw new MemoryStorageError(`Failed to add memory for ${channelName}`, error);
    }
}

/**
 * Merges fields into an existing memory.
 * @param {string} channelName
 * @param {string} memoryId
 * @param {object} fields
 */
export async function updateMemory(channelName, memoryId, fields) {
    try {
        await _itemsRef(channelName).doc(memoryId).set({ ...fields, updatedAt: new Date() }, { merge: true });
    } catch (error) {
        logger.error({ err: error, channel: channelName, memoryId }, `[MemoryStorage] Error updating memory for channel ${channelName}`);
        throw new MemoryStorageError(`Failed to update memory ${memoryId} for ${channelName}`, error);
    }
}

/**
 * Deletes memories by id.
 * @param {string} channelName
 * @param {string[]} memoryIds
 */
export async function deleteMemories(channelName, memoryIds) {
    if (!memoryIds || memoryIds.length === 0) return;
    try {
        const items = _itemsRef(channelName);
        await Promise.all(memoryIds.map(id => items.doc(id).delete()));
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `[MemoryStorage] Error deleting memories for channel ${channelName}`);
        throw new MemoryStorageError(`Failed to delete memories for ${channelName}`, error);
    }
}

/**
 * Records that a user does not want to be remembered in this channel.
 * @param {string} channelName
 * @param {string} login Lowercase login.
 */
export async function addOptOut(channelName, login) {
    try {
        await _channelRef(channelName).set({
            channelName: normalizeChannelName(channelName),
            optedOut: FieldValue.arrayUnion(login.toLowerCase()),
            updatedAt: new Date(),
        }, { merge: true });
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `[MemoryStorage] Error saving opt-out for channel ${channelName}`);
        throw new MemoryStorageError(`Failed to save opt-out for ${channelName}`, error);
    }
}

/**
 * Turns memory on or off for a channel. Turning it off keeps what was already stored; it just
 * stops being captured and used.
 * @param {string} channelName
 * @param {boolean} enabled
 */
export async function setChannelMemoryEnabled(channelName, enabled) {
    try {
        await _channelRef(channelName).set({
            channelName: normalizeChannelName(channelName),
            enabled: !!enabled,
            updatedAt: new Date(),
        }, { merge: true });
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `[MemoryStorage] Error saving memory setting for channel ${channelName}`);
        throw new MemoryStorageError(`Failed to save memory setting for ${channelName}`, error);
    }
}

/**
 * Bumps usage counters on memories that were handed to the LLM. Fire-and-forget: a lost counter
 * update only affects pruning order.
 * @param {string} channelName
 * @param {string[]} memoryIds
 */
export function bumpUsage(channelName, memoryIds) {
    let items;
    try {
        items = _itemsRef(channelName);
    } catch (err) {
        logger.debug({ err, channel: channelName }, '[MemoryStorage] Usage bump skipped');
        return;
    }
    for (const id of memoryIds) {
        items.doc(id).set({
            useCount: FieldValue.increment(1),
            lastUsedAt: new Date(),
        }, { merge: true }).catch(err => {
            logger.debug({ err, channel: channelName, memoryId: id }, '[MemoryStorage] Usage bump failed');
        });
    }
}

/**
 * Stashes chat lines that have not been through extraction yet. Called at shutdown, where there
 * is no time for an LLM call.
 * @param {string} channelName
 * @param {{username: string, message: string, ts: number}[]} messages
 */
export async function savePendingMessages(channelName, messages) {
    try {
        await _pendingRef(channelName).set({
            channelName: normalizeChannelName(channelName),
            messages,
            updatedAt: new Date(),
        });
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `[MemoryStorage] Error stashing pending messages for channel ${channelName}`);
        throw new MemoryStorageError(`Failed to stash pending messages for ${channelName}`, error);
    }
}

/**
 * Returns and removes the stashed chat lines for a channel.
 * @param {string} channelName
 * @returns {Promise<{username: string, message: string, ts: number}[]>}
 */
export async function takePendingMessages(channelName) {
    try {
        const docRef = _pendingRef(channelName);
        const snap = await docRef.get();
        if (!snap.exists) return [];
        const messages = snap.data().messages || [];
        await docRef.delete();
        return messages;
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `[MemoryStorage] Error reading pending messages for channel ${channelName}`);
        throw new MemoryStorageError(`Failed to read pending messages for ${channelName}`, error);
    }
}
