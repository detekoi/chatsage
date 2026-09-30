// src/lib/channelOwnership.js
// Assigns each channel to exactly one bot instance.
//
// Cloud Run can run several instances at once, and every in-memory component
// (timers, auto-chat, ad polling, games, chat context, LLM sessions) would
// otherwise run once per instance: duplicate timer posts, and each instance
// seeing only the share of chat that happened to be routed to it. Instead a
// channel is leased to one instance through a Firestore document, and only
// the lease holder acts for it. Webhooks that land on another instance are
// forwarded to the holder through channelInbox.js.
//
// Layout:
//   channelLeases/{broadcasterId}  { ownerId, channelName, expiresAt, ... }
//   botInstances/{instanceId}      { expiresAt, revision, ownedChannels }
//
// The holder renews every RENEW_INTERVAL_MS; a lease nobody renews expires
// after LEASE_TTL_MS and the next instance to need the channel takes it over.
// Leases are only held while they matter (the stream is live, or the channel
// saw activity in the last IDLE_RELEASE_MS), so an offline channel costs no
// writes. Both collections want a Firestore TTL policy on `expiresAt` to reap
// documents left behind by instances that died without releasing them; the
// code never depends on that sweep, it compares `expiresAt` itself.
//
// When ownership is disabled (local dev, tests) every check reports that this
// process owns every channel, which is exactly the single-process behaviour.

import crypto from 'crypto';
import { getFirestore, FieldValue } from './firestore.js';
import logger from './logger.js';
import config from '../config/index.js';
import { getBroadcasterIdForChannel } from './allowList.js';

const LEASES_COLLECTION = 'channelLeases';
const INSTANCES_COLLECTION = 'botInstances';

export const LEASE_TTL_MS = 30 * 1000;
export const RENEW_INTERVAL_MS = 10 * 1000;
// Stop acting this long before the lease can expire, so a slow renewal or a
// little clock skew between instances never leaves two owners acting at once.
export const SAFETY_MARGIN_MS = 5 * 1000;
export const IDLE_RELEASE_MS = 10 * 60 * 1000;
const READY_TIMEOUT_MS = 15 * 1000;

const instanceId = `${config.app.revision || 'local'}-${crypto.randomUUID().slice(0, 8)}`;

// broadcasterId -> { channelName, deadlineMs, lastActivityMs }
const owned = new Map();
// broadcasterId -> Promise, so concurrent acquires of one channel share a transaction
const inFlight = new Map();
const changeListeners = new Set();

let intervalId = null;
let sweepInProgress = false;
let options = { getCandidates: () => [], isChannelLive: () => false };
let readyResolve;
let readyPromise = new Promise(resolve => { readyResolve = resolve; });
let isReady = false;

export function isOwnershipEnabled() {
    return config.cluster?.channelOwnershipEnabled === true;
}

export function getInstanceId() {
    return instanceId;
}

function toMillis(value) {
    if (!value) return 0;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (value instanceof Date) return value.getTime();
    return Number(value) || 0;
}

function emit(type, broadcasterId, channelName, reason) {
    for (const listener of changeListeners) {
        try {
            listener({ type, broadcasterId, channelName, reason });
        } catch (err) {
            logger.error({ err, type, broadcasterId }, '[ChannelOwnership] Ownership listener threw');
        }
    }
}

/**
 * Registers a callback for ownership changes.
 * @param {(change: {type: 'acquired'|'lost', broadcasterId: string, channelName: string, reason?: string}) => void} listener
 * @returns {Function} Unsubscribe function.
 */
export function onOwnershipChange(listener) {
    changeListeners.add(listener);
    return () => changeListeners.delete(listener);
}

/**
 * Whether this instance currently owns the channel. Synchronous: answered from
 * the local lease record, which stops counting SAFETY_MARGIN_MS before the
 * Firestore lease could expire.
 * @param {string} broadcasterId
 * @returns {boolean}
 */
export function ownsBroadcaster(broadcasterId) {
    if (!isOwnershipEnabled()) return true;
    const entry = owned.get(String(broadcasterId));
    return !!entry && entry.deadlineMs > Date.now();
}

/**
 * Login-name form of ownsBroadcaster, for components keyed by channel name.
 * @param {string} channelName - Channel login, with or without '#'.
 * @returns {boolean}
 */
export function ownsChannel(channelName) {
    if (!isOwnershipEnabled()) return true;
    const broadcasterId = getBroadcasterIdForChannel(channelName);
    return broadcasterId ? ownsBroadcaster(broadcasterId) : false;
}

/**
 * Records activity on an owned channel so an offline channel with an active
 * conversation or game is not released as idle.
 * @param {string} broadcasterId
 */
export function touchBroadcaster(broadcasterId) {
    const entry = owned.get(String(broadcasterId));
    if (entry) entry.lastActivityMs = Date.now();
}

/**
 * Resolves once startChannelOwnership() has finished its first sweep, or after
 * a timeout. Webhooks that arrive during a cold start wait on this so they are
 * routed with the startup leases already in place.
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>} Whether ownership is ready.
 */
export async function whenOwnershipReady(timeoutMs = READY_TIMEOUT_MS) {
    if (!isOwnershipEnabled() || isReady) return true;
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); });
    try {
        return await Promise.race([readyPromise.then(() => true), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

async function runAcquire(broadcasterId, channelName) {
    const db = getFirestore();
    const ref = db.collection(LEASES_COLLECTION).doc(broadcasterId);
    // Measured before the transaction: the local deadline must never run past
    // the expiry written to Firestore, however long the round trip takes.
    const startedAt = Date.now();

    const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const data = snap.exists ? snap.data() : null;
        const now = Date.now();
        if (data && data.ownerId !== instanceId && toMillis(data.expiresAt) > now) {
            return { owned: false, ownerId: data.ownerId };
        }
        const lease = {
            ownerId: instanceId,
            channelName,
            expiresAt: new Date(now + LEASE_TTL_MS),
            renewedAt: FieldValue.serverTimestamp(),
        };
        if (data?.ownerId !== instanceId) {
            lease.acquiredAt = FieldValue.serverTimestamp();
            lease.previousOwnerId = data?.ownerId || null;
        } else {
            // set() replaces the document, so a renewal carries the handover
            // fields forward rather than dropping them.
            lease.acquiredAt = data.acquiredAt ?? null;
            lease.previousOwnerId = data.previousOwnerId ?? null;
        }
        tx.set(ref, lease);
        return { owned: true, ownerId: instanceId, previousOwnerId: data?.ownerId || null };
    });

    const previous = owned.get(broadcasterId);
    if (result.owned) {
        owned.set(broadcasterId, {
            channelName,
            deadlineMs: startedAt + LEASE_TTL_MS - SAFETY_MARGIN_MS,
            lastActivityMs: previous?.lastActivityMs ?? Date.now(),
        });
        if (!previous) {
            logger.info({ channelName, broadcasterId, previousOwnerId: result.previousOwnerId, instanceId },
                '[ChannelOwnership] Acquired channel');
            emit('acquired', broadcasterId, channelName);
        }
    } else if (previous) {
        owned.delete(broadcasterId);
        logger.warn({ channelName, broadcasterId, ownerId: result.ownerId, instanceId },
            '[ChannelOwnership] Lease taken by another instance, dropping channel');
        emit('lost', broadcasterId, channelName, 'taken');
    }
    return result;
}

/**
 * Acquires or renews the lease on a channel. Succeeds when the lease is free,
 * expired, or already ours.
 * @param {string} broadcasterId
 * @param {string} channelName
 * @returns {Promise<{owned: boolean, ownerId: string}>}
 */
export async function claimChannel(broadcasterId, channelName) {
    const id = String(broadcasterId);
    if (!isOwnershipEnabled()) return { owned: true, ownerId: instanceId };
    if (inFlight.has(id)) return inFlight.get(id);
    const promise = runAcquire(id, channelName).finally(() => inFlight.delete(id));
    inFlight.set(id, promise);
    return promise;
}

/**
 * Gives up a lease this instance holds.
 * @param {string} broadcasterId
 * @param {string} reason - For logs and listeners, e.g. 'idle' or 'shutdown'.
 */
async function releaseChannel(broadcasterId, reason) {
    const entry = owned.get(broadcasterId);
    if (!entry) return;
    owned.delete(broadcasterId);
    emit('lost', broadcasterId, entry.channelName, reason);

    try {
        const db = getFirestore();
        const ref = db.collection(LEASES_COLLECTION).doc(broadcasterId);
        await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (snap.exists && snap.data().ownerId === instanceId) {
                tx.delete(ref);
            }
        });
        logger.info({ channelName: entry.channelName, broadcasterId, reason }, '[ChannelOwnership] Released channel');
    } catch (err) {
        // The lease expires on its own; releasing early only speeds up handover.
        logger.warn({ err, broadcasterId, reason }, '[ChannelOwnership] Failed to release lease');
    }
}

function isLive(channelName) {
    try {
        return !!options.isChannelLive(channelName);
    } catch {
        return false;
    }
}

async function writeHeartbeat() {
    const db = getFirestore();
    await db.collection(INSTANCES_COLLECTION).doc(instanceId).set({
        revision: config.app.revision || null,
        expiresAt: new Date(Date.now() + LEASE_TTL_MS),
        heartbeatAt: FieldValue.serverTimestamp(),
        ownedChannels: [...owned.values()].map(e => e.channelName),
    });
}

/**
 * IDs of channels whose lease is currently held by some instance, this one
 * included. One query per sweep, instead of a claim transaction per peer-held
 * channel.
 * @returns {Promise<Set<string>>}
 */
async function getHeldLeaseIds() {
    const db = getFirestore();
    const snap = await db.collection(LEASES_COLLECTION)
        .where('expiresAt', '>', new Date())
        .get();
    return new Set(snap.docs.map(doc => doc.id));
}

async function countLiveInstances() {
    const db = getFirestore();
    const snap = await db.collection(INSTANCES_COLLECTION)
        .where('expiresAt', '>', new Date())
        .count()
        .get();
    return Math.max(1, snap.data().count || 0);
}

/**
 * One maintenance pass: heartbeat, renew or release held leases, then pick up
 * live channels that nobody holds (their owner died), up to a fair share so
 * that simultaneous instances spread the channels between them.
 */
async function sweep() {
    if (sweepInProgress) return;
    sweepInProgress = true;
    try {
        try {
            await writeHeartbeat();
        } catch (err) {
            logger.warn({ err }, '[ChannelOwnership] Heartbeat failed');
        }

        const now = Date.now();
        for (const [broadcasterId, entry] of [...owned]) {
            // A lapsed lease may already belong to someone else. Treat it as
            // lost so any state rebuilt on re-acquire starts from Firestore.
            if (entry.deadlineMs <= now) {
                owned.delete(broadcasterId);
                logger.warn({ channelName: entry.channelName, broadcasterId },
                    '[ChannelOwnership] Lease lapsed before renewal');
                emit('lost', broadcasterId, entry.channelName, 'lapsed');
                continue;
            }
            if (!isLive(entry.channelName) && now - entry.lastActivityMs > IDLE_RELEASE_MS) {
                await releaseChannel(broadcasterId, 'idle');
                continue;
            }
            try {
                await claimChannel(broadcasterId, entry.channelName);
            } catch (err) {
                logger.warn({ err, broadcasterId }, '[ChannelOwnership] Lease renewal failed, will retry');
            }
        }

        const liveCandidates = options.getCandidates().filter(c => isLive(c.channelName));
        const notMine = liveCandidates.filter(c => !owned.has(c.broadcasterId));
        if (notMine.length === 0) return;

        // Most live channels this instance does not own are healthily held by a
        // peer. Only a channel with no valid lease is an orphan worth claiming.
        let held;
        try {
            held = await getHeldLeaseIds();
        } catch (err) {
            logger.warn({ err }, '[ChannelOwnership] Could not read leases, skipping orphan claims this sweep');
            return;
        }
        const orphans = notMine.filter(c => !held.has(c.broadcasterId));
        if (orphans.length === 0) return;

        let instances = 1;
        try {
            instances = await countLiveInstances();
        } catch (err) {
            logger.warn({ err }, '[ChannelOwnership] Could not count live instances, assuming one');
        }
        const fairShare = Math.ceil(liveCandidates.length / instances);
        for (const candidate of orphans) {
            const ownedLive = [...owned.values()].filter(e => isLive(e.channelName)).length;
            if (ownedLive >= fairShare) break;
            try {
                await claimChannel(candidate.broadcasterId, candidate.channelName);
            } catch (err) {
                logger.warn({ err, broadcasterId: candidate.broadcasterId }, '[ChannelOwnership] Claim failed');
            }
        }
    } finally {
        sweepInProgress = false;
    }
}

/**
 * Starts lease maintenance. The first sweep completes before this resolves,
 * so components started afterwards see this instance's startup leases.
 * @param {object} opts
 * @param {() => Array<{broadcasterId: string, channelName: string}>} opts.getCandidates - Channels this bot serves.
 * @param {(channelName: string) => boolean} opts.isChannelLive
 */
export async function startChannelOwnership({ getCandidates, isChannelLive }) {
    if (!isOwnershipEnabled()) {
        logger.info('[ChannelOwnership] Disabled — this process acts for every channel');
        isReady = true;
        readyResolve();
        return;
    }
    if (intervalId) {
        logger.warn('[ChannelOwnership] Already running');
        return;
    }
    options = { getCandidates, isChannelLive };
    logger.info({ instanceId }, '[ChannelOwnership] Starting');
    try {
        await sweep();
    } catch (err) {
        logger.error({ err }, '[ChannelOwnership] Initial sweep failed');
    }
    intervalId = setInterval(() => {
        sweep().catch(err => logger.error({ err }, '[ChannelOwnership] Sweep failed'));
    }, RENEW_INTERVAL_MS);
    intervalId.unref?.();
    isReady = true;
    readyResolve();
    logger.info({ instanceId, owned: [...owned.values()].map(e => e.channelName) }, '[ChannelOwnership] Started');
}

/**
 * Stops maintenance and hands every lease back so another instance can take
 * over immediately rather than after the lease expires.
 */
export async function stopChannelOwnership() {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }
    if (!isOwnershipEnabled()) return;
    await Promise.allSettled([...owned.keys()].map(id => releaseChannel(id, 'shutdown')));
    try {
        await getFirestore().collection(INSTANCES_COLLECTION).doc(instanceId).delete();
    } catch (err) {
        logger.warn({ err }, '[ChannelOwnership] Failed to remove instance heartbeat');
    }
}

/**
 * Broadcaster IDs of the channels this instance currently holds.
 * @returns {string[]}
 */
export function getOwnedBroadcasterIds() {
    return [...owned.keys()];
}

/**
 * Names of the channels this instance currently holds, for logs and health output.
 * @returns {string[]}
 */
export function getOwnedChannelNames() {
    return [...owned.values()].map(e => e.channelName);
}

// Exported for testing only
export { sweep as _sweep };
export function _reset() {
    if (intervalId) clearInterval(intervalId);
    intervalId = null;
    owned.clear();
    inFlight.clear();
    changeListeners.clear();
    sweepInProgress = false;
    options = { getCandidates: () => [], isChannelLive: () => false };
    isReady = false;
    readyPromise = new Promise(resolve => { readyResolve = resolve; });
}
export function _getOwned() { return owned; }
