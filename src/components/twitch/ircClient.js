import tmi from 'tmi.js';
import logger from '../../lib/logger.js';

// Module-level variable to hold the client instance
let client = null;

/**
 * Initializes the tmi.js client and connects to Twitch IRC.
 * @param {object} twitchConfig - Twitch configuration object containing username, oauthToken, channels.
 * @throws {Error} If client is already initialized or connection fails critically.
 */
async function initializeIrcClient(twitchConfig) {
    if (client) {
        logger.warn('IRC client already initialized.');
        return client;
    }

    if (!twitchConfig || !twitchConfig.username || !twitchConfig.oauthToken || !twitchConfig.channels) {
        throw new Error('Missing required Twitch configuration for IRC client initialization.');
    }

    // Add '#' prefix to channels if missing
    const channelsToJoin = twitchConfig.channels.map(ch => ch.startsWith('#') ? ch : `#${ch}`);

    logger.info(`Preparing to connect to Twitch IRC as ${twitchConfig.username}...`);
    logger.debug(`Joining channels: ${channelsToJoin.join(', ')}`);

    const clientOptions = {
        options: {
            debug: config.app.logLevel === 'debug', // Enable tmi.js debug logging if app level is debug
        },
        connection: {
            reconnect: true, // Automatically attempt to reconnect if disconnected
            secure: true,    // Always use secure connection
        },
        identity: {
            username: twitchConfig.username,
            password: twitchConfig.oauthToken, // tmi.js expects the 'oauth:' prefix here
        },
        channels: channelsToJoin,
        // Customize logging - redirect tmi.js logs through our logger
        logger: {
            info: (message) => logger.info(`[tmi.js] ${message}`),
            warn: (message) => logger.warn(`[tmi.js] ${message}`),
            error: (message) => logger.error(`[tmi.js] ${message}`),
        },
    };

    // Create the client instance
    client = new tmi.Client(clientOptions);

    // --- Register Basic Event Listeners ---
    // More specific listeners (like 'message') will be handled in bot.js

    client.on('connecting', (address, port) => {
        logger.info(`Connecting to Twitch IRC at ${address}:${port}...`);
    });

    // 'connected' and 'disconnected' listeners are attached in bot.js
    // to coordinate actions like starting/stopping polling.

    client.on('reconnect', () => {
        logger.info('Attempting to reconnect to Twitch IRC...');
    });

    client.on('logon', () => {
        // This fires after successful authentication, slightly before 'connected' sometimes
        logger.info('Successfully logged on to Twitch IRC.');
    });

    // --- Error Handling ---
    client.on('error', (error) => {
        // General errors from the library
        logger.error({ err: error }, '[tmi.js] Encountered an error');
    });

    client.on('join', (channel, username, self) => {
        // Log joins, especially useful for confirming the bot joined channels
        if (self) {
            logger.info(`Joined channel: ${channel}`);
        }
    });

    client.on('part', (channel, username, self) => {
        // Log parts, especially if the bot leaves unexpectedly
        if (self) {
            logger.warn(`Left channel: ${channel}`);
        }
    });

    client.on('notice', (channel, msgid, message) => {
        // Notices can contain important info (e.g., rate limits, auth failures, chat mode changes)
        logger.warn({ channel, msgid, notice: message }, '[tmi.js] Received NOTICE');
        // Example: Check for specific bad authentication notice
        if (msgid === 'msg_bad_auth') {
             logger.fatal('Twitch IRC Authentication Failed (msg_bad_auth). Check TWITCH_BOT_OAUTH_TOKEN.');
             // Depending on desired behavior, might want to exit process here
             // process.exit(1);
        }
        // Example: Rate limit warning (though tmi.js handles some internally)
        if (msgid === 'msg_ratelimit') {
            logger.warn(`Approaching IRC rate limit in ${channel}`);
        }
    });

    // --- Connect ---
    try {
        await client.connect();
        // Note: The 'connected' event defined in bot.js will fire after this promise resolves.
        logger.debug('tmi.js client.connect() promise resolved.');
    } catch (error) {
        logger.fatal({ err: error }, 'Failed to connect to Twitch IRC during initialization.');
        client = null; // Reset client if connection failed
        throw error; // Re-throw error to halt application startup
    }
}

/**
 * Gets the initialized tmi.js client instance.
 * @returns {tmi.Client} The tmi.js client instance.
 * @throws {Error} If the client has not been initialized.
 */
function getIrcClient() {
    if (!client) {
        throw new Error('IRC client has not been initialized. Call initializeIrcClient first.');
    }
    return client;
}

// Export the necessary functions
export { initializeIrcClient, getIrcClient };