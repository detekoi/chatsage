import tmi from 'tmi.js';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';

let client = null;

/**
 * Creates and configures the tmi.js client instance but does NOT connect.
 * @param {object} twitchConfig - Twitch configuration object.
 * @returns {tmi.Client} The configured tmi.js client instance.
 * @throws {Error} If client is already initialized or config is missing.
 */
function createIrcClient(twitchConfig) { // Renamed from initializeIrcClient
    if (client) {
        logger.warn('IRC client already initialized.');
        return client;
    }
     if (!twitchConfig || !twitchConfig.username || !twitchConfig.oauthToken || !twitchConfig.channels) {
        throw new Error('Missing required Twitch configuration for IRC client initialization.');
    }
     const channelsToJoin = twitchConfig.channels.map(ch => ch.startsWith('#') ? ch : `#${ch}`);
     logger.info(`Creating IRC client for ${twitchConfig.username}...`);
     logger.debug(`Target channels: ${channelsToJoin.join(', ')}`);

    const clientOptions = { /* ... options remain the same ... */
        options: { debug: config.app.logLevel === 'debug', },
        connection: { reconnect: true, secure: true, },
        identity: { username: twitchConfig.username, password: twitchConfig.oauthToken, },
        channels: channelsToJoin,
        logger: { /* ... logger remains the same ... */
            info: (message) => logger.info(`[tmi.js] ${message}`),
            warn: (message) => logger.warn(`[tmi.js] ${message}`),
            error: (message) => logger.error(`[tmi.js] ${message}`),
        },
    };

    client = new tmi.Client(clientOptions);
    logger.info('IRC Client instance created.');
    return client;
}

/**
 * Connects the previously created IRC client instance.
 * @returns {Promise<void>} Resolves on successful connection, rejects on failure.
 * @throws {Error} If the client hasn't been created first.
 */
async function connectIrcClient() {
    if (!client) {
        throw new Error('IRC Client has not been created. Call createIrcClient first.');
    }
    logger.info('Connecting IRC client...');
    try {
        // client.connect() returns a promise that resolves with [address, port] on connection
        await client.connect();
        logger.debug('ircClient.connect() promise resolved.');
        // Note: The 'connected' event usually fires right around when this promise resolves.
    } catch (error) {
        logger.fatal({ err: error }, 'Failed to connect to Twitch IRC.');
        // Don't nullify client here, as tmi.js might still try reconnecting based on options
        throw error;
    }
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