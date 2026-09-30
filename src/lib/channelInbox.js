// src/lib/channelInbox.js
// Hands EventSub notifications to the instance that owns their channel.
//
// Twitch delivers each webhook to whichever Cloud Run instance the load
// balancer picks. When that is not the channel's owner (channelOwnership.js),
// the notification is written to the channel's inbox and the owner, which
// listens on it, processes it instead.
//
// Layout: channelInbox/{broadcasterId}/inboxEvents/{messageId}
//   { payload, isChat, targetOwner, fromInstance, enqueuedAt, expiresAt }
//
// Keying by the EventSub message ID makes a retried delivery overwrite rather
// than duplicate. The owner claims each document by deleting it in a
// transaction before acting, so an event is processed at most once even while
// ownership is changing hands. `expiresAt` wants a Firestore TTL policy to reap
// events whose channel never got an owner.

import { getFirestore } from './firestore.js';
import logger from './logger.js';
import { getInstanceId, ownsBroadcaster, touchBroadcaster } from './channelOwnership.js';

const INBOX_COLLECTION = 'channelInbox';
const EVENTS_SUBCOLLECTION = 'inboxEvents';

// A chat reply this late reads as a non sequitur; other events (stream
// offline, raids, subs) still matter a while longer.
export const MAX_CHAT_AGE_MS = 2 * 60 * 1000;
export const MAX_EVENT_AGE_MS = 10 * 60 * 1000;
const DOC_TTL_MS = 60 * 60 * 1000;
const LISTENER_RETRY_MS = 5 * 1000;

// broadcasterId -> { unsubscribe, chain }
const inboxes = new Map();
// broadcasterId -> pending restart of a listener that died, cancelled by stopInbox
const retryTimers = new Map();

function eventsCollection(broadcasterId) {
    return getFirestore().collection(INBOX_COLLECTION).doc(String(broadcasterId)).collection(EVENTS_SUBCOLLECTION);
}

function toMillis(value) {
    if (!value) return 0;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (value instanceof Date) return value.getTime();
    return Number(value) || 0;
}

/**
 * Queues a notification for the channel's owner.
 * @param {string} broadcasterId
 * @param {object} event
 * @param {string} event.messageId - EventSub message ID.
 * @param {string} event.payload - Raw notification JSON.
 * @param {boolean} event.isChat
 * @param {string} event.targetOwner - Instance that held the lease when forwarded.
 */
export async function forwardToInbox(broadcasterId, { messageId, payload, isChat, targetOwner }) {
    const now = Date.now();
    const docId = String(messageId).replace(/\//g, '_');
    await eventsCollection(broadcasterId).doc(docId).set({
        payload,
        isChat: !!isChat,
        targetOwner: targetOwner || null,
        fromInstance: getInstanceId(),
        enqueuedAt: new Date(now),
        expiresAt: new Date(now + DOC_TTL_MS),
    });
}

async function consume(broadcasterId, ref, handler) {
    // The listener is torn down when ownership goes, but a snapshot can land in
    // between. Leave the event for whoever owns the channel now.
    if (!ownsBroadcaster(broadcasterId)) return;

    const db = getFirestore();
    const data = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return null;
        tx.delete(ref);
        return snap.data();
    });
    if (!data) return;

    const ageMs = Date.now() - toMillis(data.enqueuedAt);
    if (ageMs > (data.isChat ? MAX_CHAT_AGE_MS : MAX_EVENT_AGE_MS)) {
        logger.warn({ broadcasterId, messageId: ref.id, ageMs }, '[ChannelInbox] Dropping stale forwarded event');
        return;
    }

    let notification;
    try {
        notification = JSON.parse(data.payload);
    } catch (err) {
        logger.error({ err, broadcasterId, messageId: ref.id }, '[ChannelInbox] Forwarded event is not valid JSON');
        return;
    }

    touchBroadcaster(broadcasterId);
    logger.debug({ broadcasterId, messageId: ref.id, fromInstance: data.fromInstance, ageMs },
        '[ChannelInbox] Processing forwarded event');

    // Claimed in arrival order, but handled concurrently the way direct
    // webhooks are: a slow LLM reply must not hold up the next chat message.
    Promise.resolve()
        .then(() => handler(notification, ref.id))
        .catch(err => logger.error({ err, broadcasterId, messageId: ref.id }, '[ChannelInbox] Handler failed'));
}

/**
 * Starts processing a channel's inbox. Events already waiting (forwarded while
 * the channel was changing hands) arrive in the listener's first snapshot.
 * @param {string} broadcasterId
 * @param {(notification: object, messageId: string) => Promise<void>} handler
 */
export function startInbox(broadcasterId, handler) {
    const id = String(broadcasterId);
    if (inboxes.has(id)) return;
    const retry = retryTimers.get(id);
    if (retry) {
        clearTimeout(retry);
        retryTimers.delete(id);
    }

    const entry = { chain: Promise.resolve(), unsubscribe: null };
    inboxes.set(id, entry);
    entry.unsubscribe = eventsCollection(id)
        .orderBy('enqueuedAt')
        .onSnapshot(snapshot => {
            for (const change of snapshot.docChanges()) {
                if (change.type !== 'added') continue;
                const ref = change.doc.ref;
                entry.chain = entry.chain
                    .then(() => consume(id, ref, handler))
                    .catch(err => logger.error({ err, broadcasterId: id, messageId: ref.id }, '[ChannelInbox] Failed to claim event'));
            }
        }, err => {
            // The SDK retries transient failures itself; reaching this callback
            // means the listener is dead. Forget it and listen again while this
            // instance still owns the channel, or forwarded events pile up unread.
            logger.error({ err, broadcasterId: id }, '[ChannelInbox] Inbox listener error, restarting');
            if (inboxes.get(id) !== entry) return;
            inboxes.delete(id);
            const retry = setTimeout(() => {
                retryTimers.delete(id);
                if (ownsBroadcaster(id) && !inboxes.has(id)) startInbox(id, handler);
            }, LISTENER_RETRY_MS);
            retry.unref?.();
            retryTimers.set(id, retry);
        });
    logger.debug({ broadcasterId: id }, '[ChannelInbox] Listening');
}

/**
 * @param {string} broadcasterId
 */
export function stopInbox(broadcasterId) {
    const id = String(broadcasterId);
    const retry = retryTimers.get(id);
    if (retry) {
        clearTimeout(retry);
        retryTimers.delete(id);
    }
    const entry = inboxes.get(id);
    if (!entry) return;
    inboxes.delete(id);
    try {
        entry.unsubscribe?.();
    } catch (err) {
        logger.warn({ err, broadcasterId: id }, '[ChannelInbox] Error stopping listener');
    }
}

export function stopAllInboxes() {
    for (const id of new Set([...inboxes.keys(), ...retryTimers.keys()])) stopInbox(id);
}

// Exported for testing only
export { consume as _consume };
export function _getInboxes() { return inboxes; }
