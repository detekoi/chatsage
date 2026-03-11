// src/components/llm/conversationStorage.js
// Stores user message + bot response pairs in Firestore for prompt engineering.
// Documents auto-delete after 14 days via Firestore TTL on the `expiresAt` field.
//
// Setup TTL (run once after first deploy):
//   gcloud firestore fields ttls update expiresAt \
//     --collection-group=conversations \
//     --project=streamsage-bot

import { Firestore, Timestamp } from '@google-cloud/firestore';
import logger from '../../lib/logger.js';

const CONVERSATIONS_COLLECTION = 'conversations';
const TTL_DAYS = 14;

let db = null;

/**
 * Initialize the Firestore client for conversation storage.
 * Called during app startup from initComponents.js.
 */
export async function initializeConversationStorage() {
    logger.info('[ConversationStorage] Initializing Firestore client...');
    try {
        db = new Firestore();
        // Quick connectivity test
        await db.collection(CONVERSATIONS_COLLECTION).limit(1).get();
        logger.info('[ConversationStorage] Firestore initialized.');
    } catch (err) {
        // Non-fatal: conversation logging is optional, don't prevent bot startup
        logger.warn({ err }, '[ConversationStorage] Failed to initialize Firestore. Conversation logging disabled.');
        db = null;
    }
}

/**
 * Log a conversation pair (user message + bot response) to Firestore.
 * Fire-and-forget — errors are logged but never thrown.
 *
 * @param {string} channel - Channel name (without '#').
 * @param {string} userMessage - The user's message that triggered the bot.
 * @param {string} botResponse - The bot's final response text.
 * @param {object} [metadata] - Additional metadata.
 * @param {string} [metadata.trigger] - What triggered the response (mention, reply, etc.).
 * @param {number} [metadata.responseLength] - Character count of the response.
 * @param {boolean} [metadata.summarized] - Whether the response was summarized.
 * @param {number} [metadata.latencyMs] - LLM round-trip time in ms.
 */
export async function logConversation(channel, userMessage, botResponse, metadata = {}) {
    if (!db) return; // Storage not initialized or init failed

    try {
        const now = new Date();
        const expiresAt = new Date(now.getTime() + TTL_DAYS * 24 * 60 * 60 * 1000);

        const doc = {
            channel,
            userMessage,
            botResponse,
            createdAt: Timestamp.fromDate(now),
            expiresAt: Timestamp.fromDate(expiresAt),
        };

        // Only include metadata fields that have values
        if (metadata.trigger) doc.trigger = metadata.trigger;
        if (metadata.responseLength != null) doc.responseLength = metadata.responseLength;
        if (metadata.summarized != null) doc.summarized = metadata.summarized;
        if (metadata.latencyMs != null) doc.latencyMs = metadata.latencyMs;

        await db.collection(CONVERSATIONS_COLLECTION).add(doc);
        logger.debug({ channel }, '[ConversationStorage] Conversation logged.');
    } catch (err) {
        logger.warn({ err, channel }, '[ConversationStorage] Failed to log conversation.');
    }
}
