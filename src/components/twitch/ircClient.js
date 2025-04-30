import tmi from 'tmi.js';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';
// Import the token management helpers
import { getValidIrcToken, refreshIrcToken } from './ircAuthHelper.js';

let client = null;
let connectionAttemptPromise = null; // To manage connection state

/**
 * Creates and configures the tmi.js client instance using a dynamically fetched token.
 * Does NOT connect automatically.
 * @param {object} twitchConfig - Twitch configuration object.
 * @returns {Promise<tmi.Client>} The configured tmi.js client instance.
 * @throws {Error} If client is already initialized, config is missing, or token fetch fails.
 */
async function createIrcClient(twitchConfig) {
    if (client) {
        logger.warn('IRC client instance already exists.');
        return client; // Return existing instance
    }
    if (!twitchConfig || !twitchConfig.username || !twitchConfig.channels) {
        throw new Error('Missing required Twitch configuration (username, channels) for IRC client.');
    }

    logger.info(`Attempting to create IRC client for ${twitchConfig.username}...`);

    // Fetch the token dynamically
    let ircPassword = null;
    try {
        logger.info('Fetching initial IRC token via Auth Helper...');
        ircPassword = await getValidIrcToken(); // Use the helper
        if (!ircPassword) {
            throw new Error('Failed to obtain initial valid IRC token. Check logs and secret configuration.');
        }
        logger.info('Successfully obtained initial IRC token.');
    } catch (error) {
        logger.fatal({ err: error }, 'Fatal error obtaining initial IRC token during client creation.');
        throw error; // Prevent client creation if token fetch fails critically
    }

    const channelsToJoin = twitchConfig.channels.map(ch => ch.startsWith('#') ? ch : `#${ch}`);
    logger.debug(`Target channels: ${channelsToJoin.join(', ')}`);

    const clientOptions = {
        options: { debug: config.app.logLevel === 'debug' },
        connection: {
            reconnect: true, // Let tmi handle basic reconnects
            secure: true,
            timeout: 90000, // Increase timeout slightly
            maxReconnectAttempts: 5, // Limit automatic reconnects by tmi
            maxReconnectInterval: 30000,
            reconnectDecay: 1.5,
            reconnectJitter: 1000
        },
        identity: {
            username: twitchConfig.username,
            password: ircPassword, // Use the fetched token
        },
        channels: channelsToJoin,
        logger: {
            info: (message) => logger.info(`[tmi.js] ${message}`),
            warn: (message) => logger.warn(`[tmi.js] ${message}`),
            error: (message) => logger.error(`[tmi.js] ${message}`),
        },
    };

    client = new tmi.Client(clientOptions);
    logger.info('IRC Client instance created.');

    // Enhanced Error/Notice Handling with authentication recovery
    client.on('notice', async (channel, msgid, message) => {
        logger.warn(
            { channel: channel || 'N/A', msgid: msgid || 'N/A', notice: message || '' },
            '[TMI Server Notice]'
        );
        // Check specifically for login failure notice
        if (msgid === 'msg_login_unsuccessful' || message?.toLowerCase().includes('login unsuccessful')) {
            logger.error('Login unsuccessful notice received. Token might be invalid.');
            // Attempt to refresh and reconnect if not already doing so
            await handleAuthenticationFailure();
        }
        // Handle other notices like 'msg_requires_verified_email' if needed
    });

    client.on('error', async (error) => {
        logger.error({ err: error }, '[TMI Client Error]');
        // Check if the error indicates an authentication issue that might require a refresh
        if (error?.message?.toLowerCase().includes('authentication failed') ||
            error?.message?.toLowerCase().includes('login unsuccessful')) {
            logger.error('Authentication error detected. Token might be invalid.');
            await handleAuthenticationFailure();
        }
    });

    client.on('disconnected', (reason) => {
        logger.warn(`Disconnected from Twitch IRC: ${reason || 'Unknown reason'}`);
        // Reset connection promise if connection failed/dropped
        connectionAttemptPromise = null;
    });

    return client;
}

/**
 * Handler for authentication failures that attempts to refresh the token and reconnect.
 */
async function handleAuthenticationFailure() {
    if (!client) return; // No client instance

    // Prevent multiple concurrent refresh/reconnect attempts
    if (connectionAttemptPromise) {
        logger.warn('Authentication failure handling already in progress. Skipping.');
        return;
    }

    logger.warn('Attempting to handle authentication failure: Refreshing token and reconnecting...');

    // Disconnect cleanly first if connected/connecting
    if (client.readyState() === 'OPEN' || client.readyState() === 'CONNECTING') {
        try {
            await client.disconnect();
            logger.info('Disconnected client before attempting token refresh.');
        } catch (disconnectErr) {
            logger.error({ err: disconnectErr }, 'Error disconnecting client before refresh.');
        }
    }

    connectionAttemptPromise = (async () => {
        try {
            const newToken = await refreshIrcToken(); // Use the helper's refresh function
            if (newToken) {
                logger.info('Token refreshed successfully after auth failure. Updating client options...');
                // Update the client's password option for the next connection attempt
                client.opts.identity.password = `oauth:${newToken}`;

                logger.info('Attempting to reconnect with the new token...');
                await client.connect(); // tmi.js connect handles the connection logic
                logger.info('Reconnection attempt initiated with new token.');
                // If connect() resolves, the 'connected' event should fire.
            } else {
                logger.error('Failed to refresh token after authentication failure. Cannot reconnect automatically. Manual intervention likely required.');
                // Potentially stop the bot or enter a degraded state
            }
        } catch (error) {
            logger.error({ err: error }, 'Error during authentication failure handling (refresh/reconnect).');
        } finally {
            connectionAttemptPromise = null; // Clear the lock
        }
    })();

    await connectionAttemptPromise; // Wait for the handling attempt to finish
}

/**
 * Connects the previously created IRC client instance.
 * Manages connection state to prevent concurrent attempts.
 * @returns {Promise<void>} Resolves on successful connection, rejects on failure.
 * @throws {Error} If the client hasn't been created first.
 */
async function connectIrcClient() {
    if (!client) {
        throw new Error('IRC Client has not been created. Call createIrcClient first.');
    }
    if (connectionAttemptPromise) {
        logger.warn('Connection attempt already in progress.');
        return connectionAttemptPromise; // Return the existing promise
    }
    if (client.readyState() === 'OPEN') {
        logger.info('Client already connected.');
        return Promise.resolve();
    }

    logger.info('Connecting IRC client...');
    connectionAttemptPromise = client.connect().catch(error => {
        logger.fatal({ err: error }, 'Failed to connect to Twitch IRC during initial connect call.');
        connectionAttemptPromise = null; // Clear promise on failure
        throw error; // Re-throw to signal connection failure
    });

    return connectionAttemptPromise;
}


function getIrcClient() {
    if (!client) {
        // Modify error message slightly
        throw new Error('IRC client has not been created/initialized.');
    }
    return client;
}

// Update exports
export { createIrcClient, connectIrcClient, getIrcClient };