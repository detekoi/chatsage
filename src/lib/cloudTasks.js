// src/lib/cloudTasks.js
// Durable scheduling for work that must survive the instance being scaled to
// zero. Cloud Run reaps idle instances after ~15 minutes, which silently
// destroys any pending setTimeout. A Cloud Task instead lives in a queue and
// delivers an authenticated HTTP POST at its scheduled time, cold-starting the
// service if needed.
//
// When targetUrl is not configured (local dev), every helper reports that
// scheduling is unavailable so callers can fall back to an in-process timer.

import logger from './logger.js';
import config from '../config/index.js';

let clientPromise = null;
let verifierPromise = null;

/**
 * Whether durable scheduling is available. False in local dev, where callers
 * should fall back to setTimeout.
 * @returns {boolean}
 */
export function isCloudTasksEnabled() {
    const cfg = config.cloudTasks;
    return !!(cfg?.projectId && cfg?.targetUrl && cfg?.invokerServiceAccount);
}

async function getClient() {
    if (!clientPromise) {
        clientPromise = import('@google-cloud/tasks').then(({ CloudTasksClient }) => new CloudTasksClient());
    }
    return clientPromise;
}

async function getVerifier() {
    if (!verifierPromise) {
        verifierPromise = import('google-auth-library').then(({ OAuth2Client }) => new OAuth2Client());
    }
    return verifierPromise;
}

/**
 * Cloud Tasks task IDs allow only letters, numbers, hyphens and underscores.
 * @param {string} value
 * @returns {string}
 */
function sanitizeTaskId(value) {
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 500);
}

/**
 * Builds a deterministic task ID. Because Cloud Tasks rejects a duplicate ID
 * for roughly an hour after a task completes, the ID itself provides
 * cross-instance de-duplication — two instances racing to schedule the same
 * work produce one task, not two.
 * @param {string} kind - Logical task type, e.g. 'ad'
 * @param {string} channelName
 * @param {number} uniqueMs - Timestamp that identifies this specific occurrence
 * @returns {string}
 */
export function buildTaskId(kind, channelName, uniqueMs) {
    return sanitizeTaskId(`${kind}-${channelName}-${uniqueMs}`);
}

/**
 * Enqueues an HTTP task to be delivered at a specific time.
 *
 * @param {Object} options
 * @param {string} options.taskId - Deterministic ID, see buildTaskId()
 * @param {Object} options.payload - JSON body delivered to the handler
 * @param {number} options.deliverAtMs - Epoch ms at which to deliver
 * @returns {Promise<{scheduled: boolean, duplicate?: boolean, reason?: string}>}
 */
export async function scheduleTask({ taskId, payload, deliverAtMs }) {
    if (!isCloudTasksEnabled()) {
        return { scheduled: false, reason: 'not-configured' };
    }

    const { projectId, location, queue, targetUrl, invokerServiceAccount } = config.cloudTasks;

    try {
        const client = await getClient();
        const parent = client.queuePath(projectId, location, queue);

        await client.createTask({
            parent,
            task: {
                name: `${parent}/tasks/${taskId}`,
                scheduleTime: { seconds: Math.floor(deliverAtMs / 1000) },
                httpRequest: {
                    httpMethod: 'POST',
                    url: targetUrl,
                    headers: { 'Content-Type': 'application/json' },
                    body: Buffer.from(JSON.stringify(payload)).toString('base64'),
                    oidcToken: {
                        serviceAccountEmail: invokerServiceAccount,
                        audience: targetUrl,
                    },
                },
            },
        });

        logger.info({ taskId, deliverAt: new Date(deliverAtMs).toISOString() }, '[CloudTasks] Task scheduled');
        return { scheduled: true };
    } catch (err) {
        // ALREADY_EXISTS (6) means another instance already scheduled this exact
        // occurrence. That is the de-duplication working, not a failure.
        if (err?.code === 6) {
            logger.debug({ taskId }, '[CloudTasks] Task already scheduled, skipping duplicate');
            return { scheduled: false, duplicate: true };
        }
        logger.error({ err, taskId }, '[CloudTasks] Failed to schedule task');
        return { scheduled: false, reason: err?.message || 'unknown' };
    }
}

/**
 * Best-effort cancellation of a pending task. A task that has already been
 * delivered or never existed is not an error — handlers re-validate their
 * preconditions at delivery time, so a stale task is harmless.
 * @param {string} taskId
 * @returns {Promise<boolean>} True if a pending task was deleted
 */
export async function cancelTask(taskId) {
    if (!isCloudTasksEnabled()) return false;

    const { projectId, location, queue } = config.cloudTasks;

    try {
        const client = await getClient();
        await client.deleteTask({ name: client.taskPath(projectId, location, queue, taskId) });
        logger.debug({ taskId }, '[CloudTasks] Pending task cancelled');
        return true;
    } catch (err) {
        // NOT_FOUND (5) is expected for already-delivered tasks.
        if (err?.code !== 5) {
            logger.warn({ err, taskId }, '[CloudTasks] Failed to cancel task');
        }
        return false;
    }
}

/**
 * Verifies that an incoming request really came from our Cloud Tasks queue.
 *
 * Cloud Tasks signs each delivery with a Google-issued OIDC token for the
 * invoker service account. Validating the signature, audience and issuer means
 * the endpoint cannot be driven by anyone else who learns the URL.
 *
 * @param {string|undefined} authorizationHeader - Raw Authorization header
 * @returns {Promise<{valid: boolean, reason?: string, email?: string}>}
 */
export async function verifyTaskRequest(authorizationHeader) {
    if (!isCloudTasksEnabled()) {
        return { valid: false, reason: 'not-configured' };
    }

    const match = /^Bearer (.+)$/i.exec(authorizationHeader || '');
    if (!match) {
        return { valid: false, reason: 'missing-bearer-token' };
    }

    const { targetUrl, invokerServiceAccount } = config.cloudTasks;

    try {
        const verifier = await getVerifier();
        const ticket = await verifier.verifyIdToken({ idToken: match[1], audience: targetUrl });
        const payload = ticket.getPayload();

        if (payload?.email !== invokerServiceAccount) {
            return { valid: false, reason: 'unexpected-service-account' };
        }
        if (payload.email_verified !== true) {
            return { valid: false, reason: 'email-not-verified' };
        }

        return { valid: true, email: payload.email };
    } catch (err) {
        return { valid: false, reason: err?.message || 'token-verification-failed' };
    }
}

// Exported for testing only
export function _reset() {
    clientPromise = null;
    verifierPromise = null;
}
