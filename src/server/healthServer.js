import http from 'http';
import logger from '../lib/logger.js';
import { eventSubHandler, handleKeepAlivePing } from '../components/twitch/eventsub.js';
import { getSecretManagerStatus } from '../lib/secretManager.js';

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
            req.on('data', c => chunks.push(c));
            req.on('end', () => eventSubHandler(req, res, Buffer.concat(chunks)));
            return;
        }

        // Keep-alive ping endpoint (called by Cloud Tasks)
        if (req.method === 'POST' && req.url === '/keep-alive') {
            try {
                await handleKeepAlivePing();
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('OK');
            } catch (error) {
                logger.error({ err: error }, 'Error handling keep-alive ping');
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Internal Server Error');
            }
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
