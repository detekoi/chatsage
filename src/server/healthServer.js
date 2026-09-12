import http from 'http';
import crypto from 'crypto';
import logger from '../lib/logger.js';
import config from '../config/index.js';
import { eventSubHandler } from '../components/twitch/eventsub.js';
import { getSecretManagerStatus, getSecretValue } from '../lib/secretManager.js';
import { verifyTaskRequest } from '../lib/cloudTasks.js';
import { handleAdNotificationTask } from '../components/twitch/adSchedulePoller.js';
import { generatePreview, validatePreviewRequest } from '../components/customCommands/previewService.js';

/**
 * Reads a request body with a size cap, so a hostile or malformed request
 * cannot exhaust memory.
 * @param {http.IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
function readBody(req, maxBytes = 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on('data', (c) => {
            total += c.length;
            if (total > maxBytes) {
                req.destroy(new Error('Payload too large'));
            } else {
                chunks.push(c);
            }
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

/**
 * Handles a Cloud Tasks delivery. Work that used to run on an in-process
 * setTimeout arrives here instead, which is what lets the service scale to
 * zero without losing scheduled messages.
 *
 * Status codes matter: Cloud Tasks retries on 5xx and gives up on 2xx/4xx.
 * A task whose preconditions no longer hold is a success, not a failure.
 */
async function scheduledTaskHandler(req, res) {
    const auth = await verifyTaskRequest(req.headers.authorization);
    if (!auth.valid) {
        logger.warn({ reason: auth.reason }, '[ScheduledTask] Rejected unauthenticated delivery');
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
    }

    let payload;
    try {
        payload = JSON.parse((await readBody(req)).toString('utf8'));
    } catch (err) {
        logger.warn({ err }, '[ScheduledTask] Malformed task payload');
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request');
        return;
    }

    try {
        switch (payload?.kind) {
            case 'ad-notification': {
                const result = await handleAdNotificationTask(payload);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
                return;
            }
            default:
                // Unknown kind will never succeed on retry.
                logger.warn({ kind: payload?.kind }, '[ScheduledTask] Unknown task kind, discarding');
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Unknown task kind');
                return;
        }
    } catch (err) {
        // Transient failure (LLM, Helix, Firestore) — let Cloud Tasks retry.
        logger.error({ err, kind: payload?.kind }, '[ScheduledTask] Task handler failed, will be retried');
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Task handler failed');
    }
}

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

/**
 * Verifies a dashboard-originated request against the shared internal token.
 * The same secret already authenticates bot → web UI calls; this is the
 * reverse direction. Compared as fixed-length digests so the check is
 * constant-time and cannot throw on mismatched byte lengths.
 * @param {string|undefined} authHeader
 * @returns {Promise<{ valid: boolean, reason?: string, status?: number }>}
 */
async function verifyInternalToken(authHeader) {
    if (!config.webui?.internalToken) {
        return { valid: false, status: 503, reason: 'WEBUI_INTERNAL_TOKEN is not configured' };
    }
    const header = authHeader || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) {
        return { valid: false, status: 401, reason: 'missing bearer token' };
    }
    const expected = await getSecretValue(config.webui.internalToken);
    if (!expected) {
        return { valid: false, status: 503, reason: 'internal token unavailable from Secret Manager' };
    }
    const a = crypto.createHash('sha256').update(token, 'utf8').digest();
    const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
    return crypto.timingSafeEqual(a, b)
        ? { valid: true }
        : { valid: false, status: 401, reason: 'invalid bearer token' };
}

/**
 * Handles a dashboard "preview" request: generates a sample AI response for a
 * custom command, timer, or check-in prompt without sending anything to chat.
 * The web UI has already authenticated the broadcaster and supplies their
 * channel; this endpoint trusts that only because the shared token checks out.
 */
async function previewHandler(req, res) {
    const auth = await verifyInternalToken(req.headers.authorization);
    if (!auth.valid) {
        logger.warn({ reason: auth.reason }, '[Preview] Rejected preview request');
        sendJson(res, auth.status, { success: false, message: auth.status === 503 ? 'Preview is not configured' : 'Unauthorized' });
        return;
    }

    let payload;
    try {
        payload = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
    } catch (err) {
        logger.warn({ err }, '[Preview] Malformed preview payload');
        sendJson(res, 400, { success: false, message: 'Bad Request' });
        return;
    }

    const validationError = validatePreviewRequest(payload);
    if (validationError) {
        sendJson(res, 400, { success: false, message: validationError });
        return;
    }

    try {
        const preview = await generatePreview({
            channel: payload.channel,
            kind: payload.kind,
            prompt: payload.prompt,
            name: payload.name || null,
            args: payload.args || '',
        });
        sendJson(res, 200, { success: true, preview });
    } catch (err) {
        logger.error({ err, channel: payload.channel, kind: payload.kind }, '[Preview] Failed to generate preview');
        sendJson(res, 500, { success: false, message: 'Failed to generate preview' });
    }
}

/**
 * Helper function to listen with port fallback in development.
 * @param {http.Server} server - HTTP server instance
 * @param {number} port - Desired port number
 * @param {boolean} isDev - Whether in development mode
 * @returns {Promise<number>} The port the server is listening on
 */
async function listenWithFallback(server, port, isDev) {
    let portToTry = port;
    for (let attempt = 0; attempt < (isDev ? 5 : 1); attempt++) {
        try {
            await new Promise((resolve, reject) => {
                const onError = (err) => {
                    server.off('listening', onListening);
                    reject(err);
                };
                const onListening = () => {
                    server.off('error', onError);
                    resolve();
                };
                server.once('error', onError);
                server.once('listening', onListening);
                server.listen(portToTry);
            });
            logger.info(`Health check server listening on port ${portToTry}`);
            return portToTry;
        } catch (err) {
            if (isDev && err && err.code === 'EADDRINUSE') {
                logger.warn(`Port ${portToTry} in use. Trying ${portToTry + 1}...`);
                portToTry += 1;
                continue;
            }
            throw err;
        }
    }
    throw new Error('Failed to bind health server to an available port after several attempts.');
}

/**
 * Creates and starts the HTTP health check server.
 * @param {Object} options - Configuration options
 * @param {number} options.port - Port number to listen on
 * @param {boolean} options.isDev - Whether in development mode
 * @param {Function} options.getIsFullyInitialized - Function that returns initialization status
 * @returns {Promise<http.Server>} The created HTTP server
 */
export async function createHealthServer({ port, isDev, getIsFullyInitialized }) {
    const server = http.createServer(async (req, res) => {
        // EventSub webhook endpoint
        if (req.method === 'POST' && req.url === '/twitch/event') {
            const chunks = [];
            let totalLength = 0;
            const MAX_SIZE = 2 * 1024 * 1024; // 2MB limit to prevent OOM
            
            req.on('data', c => {
                totalLength += c.length;
                if (totalLength > MAX_SIZE) {
                    req.destroy(new Error('Payload too large'));
                } else {
                    chunks.push(c);
                }
            });
            
            req.on('end', () => {
                if (!req.destroyed) {
                    eventSubHandler(req, res, Buffer.concat(chunks)).catch(err => {
                        logger.error({ err }, 'Unhandled error in eventSubHandler');
                        if (!res.headersSent) {
                            res.writeHead(500, { 'Content-Type': 'text/plain' });
                            res.end('Internal Server Error');
                        }
                    });
                }
            });
            return;
        }

        // Cloud Tasks delivery endpoint for scheduled work
        if (req.method === 'POST' && req.url === '/internal/scheduled-task') {
            scheduledTaskHandler(req, res).catch(err => {
                logger.error({ err }, 'Unhandled error in scheduledTaskHandler');
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Internal Server Error');
                }
            });
            return;
        }

        // Dashboard preview endpoint (web UI → bot, shared internal token)
        if (req.method === 'POST' && req.url === '/internal/preview') {
            previewHandler(req, res).catch(err => {
                logger.error({ err }, 'Unhandled error in previewHandler');
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Internal Server Error');
                }
            });
            return;
        }

        // Health check endpoints (respond quickly)
        if ((req.method === 'GET' || req.method === 'HEAD') && (req.url === '/healthz' || req.url === '/')) {
            const status = getSecretManagerStatus();
            const healthStatus = status.initialized ? 'OK' : 'DEGRADED';
            const responseText = req.method === 'HEAD' ? undefined : `${healthStatus} - Secret Manager: ${status.mode}`;

            res.writeHead(status.initialized ? 200 : 503, {
                'Content-Type': 'text/plain',
                'X-Secret-Manager-Status': status.mode,
                'X-Secret-Manager-Initialized': status.initialized.toString()
            });
            res.end(responseText);
            return;
        }

        // Startup readiness check - only returns 200 when fully initialized
        if ((req.method === 'GET' || req.method === 'HEAD') && req.url === '/startupz') {
            const isFullyInitialized = getIsFullyInitialized();
            if (isFullyInitialized) {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end(req.method === 'HEAD' ? undefined : 'Ready');
            } else {
                res.writeHead(503, { 'Content-Type': 'text/plain' });
                res.end(req.method === 'HEAD' ? undefined : 'Not Ready');
            }
            return;
        }

        // 404 for everything else
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    });

    await listenWithFallback(server, port, isDev);
    return server;
}

/**
 * Gracefully closes the health server.
 * @param {http.Server} server - The server to close
 * @returns {Promise<void>}
 */
export function closeHealthServer(server) {
    return new Promise((resolve) => {
        server.close(() => {
            logger.info('Health check server closed.');
            resolve();
        });
    });
}
