// src/components/twitch/ircClient.js
import tmi from 'tmi.js';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';
import { getValidIrcToken, refreshIrcToken } from './ircAuthHelper.js';
import { stopStreamInfoPolling } from './streamInfoPoller.js';

let client = null;
let connectionAttemptPromise = null; // For general connection attempts initiated by connectIrcClient
let isHandlingAuthFailure = false; // Specific lock for the handleAuthenticationFailure process

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

    let ircPassword = null;
    try {
        logger.info('Fetching initial IRC token via Auth Helper...');
        ircPassword = await getValidIrcToken();
        if (!ircPassword) {
            logger.fatal('CRITICAL: Failed to obtain initial valid IRC token. Check logs for errors from ircAuthHelper (secret access, refresh token validity, Twitch API client_id/secret). Bot cannot connect.');
            process.exit(1);
        }
        logger.info('Successfully obtained initial IRC token.');
    } catch (error) {
        logger.fatal({ err: error }, 'Fatal error during getValidIrcToken call in client creation.');
        throw error;
    }

    const channelsToJoin = twitchConfig.channels.map(ch => ch.startsWith('#') ? ch : `#${ch}`);
    logger.debug(`Target channels: ${channelsToJoin.join(', ')}`);

    const clientOptions = {
        options: { debug: config.app.logLevel === 'debug' },
        connection: {
            reconnect: false, // tmi.js will not attempt its own reconnections on general disconnects. Handled instead by handleAuthenticationFailure.
            secure: true,
            timeout: 90000,
            maxReconnectAttempts: 5,
            maxReconnectInterval: 30000,
            reconnectDecay: 1.5,
            reconnectJitter: 1000
        },
        identity: {
            username: twitchConfig.username,
            password: ircPassword,
        },
        channels: channelsToJoin,
        logger: {
            info: (message) => logger.info(`[tmi.js] ${message}`),
            warn: (message) => logger.warn(`[tmi.js] ${message}`),
            error: (message) => logger.error(`[tmi.js] ${message}`),
        },
    };
    logger.info({tmiConnectionOptions: clientOptions.connection}, "TMI.js client connection options");


    client = new tmi.Client(clientOptions);
    logger.info('IRC Client instance created.');

    client.on('notice', async (channel, msgid, message) => {
        logger.warn(
            { channel: channel || 'N/A', msgid: msgid || 'N/A', notice: message || '' },
            '[TMI Server Notice]'
        );
        if (msgid === 'msg_login_unsuccessful' || message?.toLowerCase().includes('login unsuccessful')) {
            logger.error('Login unsuccessful notice received. Token might be invalid. Triggering authentication failure handling.');
            await handleAuthenticationFailure();
        }
    });

    client.on('error', async (error) => {
        logger.error({ err: error }, '[TMI Client Error]');
        if (error?.message?.toLowerCase().includes('authentication failed') ||
            error?.message?.toLowerCase().includes('login unsuccessful')) {
            logger.error('Authentication error detected from error event. Token might be invalid. Triggering authentication failure handling.');
            await handleAuthenticationFailure();
        }
    });

    client.on('disconnected', async (reason) => {
        const wasHandlingAuthFailure = isHandlingAuthFailure; // Capture state before nulling
        logger.warn(`Disconnected from Twitch IRC: ${reason || 'Unknown reason'}. Current connectionAttemptPromise state: ${!!connectionAttemptPromise}, isHandlingAuthFailure when disconnect started: ${wasHandlingAuthFailure}`);

        connectionAttemptPromise = null; // Always clear the general connection attempt promise

        if (isHandlingAuthFailure) {
            logger.info('Disconnected event fired, but an authentication failure handling process is already active. Letting that process complete or fail on its own.');
            return;
        }

        // If tmi.js internal reconnect is off, we need to decide how to reconnect here.
        logger.info(`TMI.js reconnect is OFF. Reason for disconnect: "${reason}". Deciding action...`);

        // Stop polling and other activities that assume a connection
        if (global.streamInfoPollerIntervalId) {
            if (typeof stopStreamInfoPolling === 'function') {
                stopStreamInfoPolling(); // Assuming you have this function accessible or implement it
            } else {
                logger.warn('stopStreamInfoPolling is not defined. Please ensure it is implemented and accessible.');
            }
        }
        // Add similar logic for other periodic tasks if needed

        // Attempt to reconnect, always trying to refresh the token first if the reason suggests auth issues
        // or even for general network issues, as the token might have expired during the downtime.
        if (reason && (reason.toLowerCase().includes('login authentication failed') || 
                       reason.toLowerCase().includes('authentication failed') || 
                       reason.toLowerCase().includes('ping timeout') ||
                       reason.toLowerCase().includes('unable to connect') // General failure
                      )) {
            logger.warn(`Disconnect reason ("${reason}") suggests a need for token refresh or connection issue. Triggering full authentication failure handling.`);
            await handleAuthenticationFailure(); // This will try to refresh token and then connect
        } else if (reason) {
            // For other specific known reasons, you might have different logic.
            // For now, let's treat most other disconnect reasons as needing a robust reconnect.
            logger.warn(`Disconnected for reason: "${reason}". Attempting robust reconnect via handleAuthenticationFailure.`);
            await handleAuthenticationFailure(); // Defaulting to full recovery to be safe
        } else {
            // If reason is null or undefined (e.g. clean client.disconnect() was called by us),
            // usually no automatic action is needed unless it was an unexpected manual disconnect.
            // If it was part of handleShutdown, that's fine.
            // If it was part of handleAuthenticationFailure's own client.disconnect(), that's also fine.
            logger.warn('Disconnected with no specific reason (or empty reason). Attempting robust reconnect via handleAuthenticationFailure as a precaution.');
            await handleAuthenticationFailure(); // <-- ADD THIS LINE TO ATTEMPT RECONNECT
        }
    });

    return client;
}

/**
 * Handler for authentication failures that attempts to refresh the token and reconnect.
 */
async function handleAuthenticationFailure() {
    logger.error('ENTERING handleAuthenticationFailure due to a suspected auth issue.');
    if (!client) {
        logger.warn('handleAuthenticationFailure called but no client instance.');
        return;
    }

    if (isHandlingAuthFailure) {
        logger.warn('handleAuthenticationFailure: An authentication failure handling process is already active. Skipping subsequent trigger.');
        return;
    }
    isHandlingAuthFailure = true; // Set specific lock for this handler

    logger.warn(`Attempting to handle authentication failure. Initial connectionAttemptPromise state: ${!!connectionAttemptPromise}. Process: Refresh token & reconnect.`);

    // If a general connectionAttemptPromise exists (e.g., from an initial connectIrcClient call that led to this auth failure),
    // it's now considered stale as this handler is taking over.
    if (connectionAttemptPromise) {
        logger.warn('handleAuthenticationFailure: Clearing potentially stale general connectionAttemptPromise.');
        connectionAttemptPromise = null;
    }

    // Disconnect the client first to ensure tmi.js is in a clean state before we try to connect with a new token.
    // This is important especially if tmi.js's own 'reconnect' is true.
    if (client.readyState() === 'OPEN' || client.readyState() === 'CONNECTING') {
        try {
            logger.info('handleAuthenticationFailure: Client is OPEN or CONNECTING. Attempting to disconnect first...');
            await client.disconnect(); // This will trigger the 'disconnected' event, which also nulls connectionAttemptPromise.
            logger.info('handleAuthenticationFailure: Disconnected client before attempting token refresh.');
        } catch (disconnectErr) {
            logger.error({ err: disconnectErr }, 'handleAuthenticationFailure: Error disconnecting client before refresh. Proceeding with token refresh attempt anyway.');
        }
    } else {
        logger.info(`handleAuthenticationFailure: Client state is ${client.readyState()}, no explicit disconnect needed before refresh attempt.`);
    }

    // This new promise is for the specific reconnection attempt within this handler
    const refreshAndConnectPromise = (async () => {
        try {
            const newToken = await refreshIrcToken(); // This function is from ircAuthHelper.js
            if (newToken) {
                logger.info('Token refreshed successfully after auth failure. Updating client options with new token...');
                client.opts.identity.password = `oauth:${newToken}`; // CRITICAL: Update the token tmi.js will use

                logger.info('Attempting to reconnect with the new token...');
                await client.connect(); // tmi.js will use the updated client.opts
                logger.info('Reconnection attempt with new token initiated successfully by handleAuthenticationFailure. Waiting for "connected" event.');
                // If client.connect() resolves, the 'connected' event should fire.
            } else {
                logger.error('Failed to refresh token after authentication failure. Cannot reconnect automatically. Manual intervention likely required. Bot may remain disconnected.');
                // Consider more drastic actions if this is a persistent issue.
            }
        } catch (error) {
            logger.error({ err: error }, 'Error occurred within the token refresh or reconnect attempt in handleAuthenticationFailure.');
            // The bot will likely remain disconnected.
        }
    })();

    try {
        await refreshAndConnectPromise; // Wait for this specific refresh & connect sequence to complete or fail.
    } catch(err) {
        // Errors from within refreshAndConnectPromise are logged there, this is a fallback.
        logger.error({err}, "Awaited refreshAndConnectPromise in handleAuthenticationFailure was rejected or threw an error itself.")
    } finally {
        isHandlingAuthFailure = false; // Release the specific lock for this handler
        logger.info('handleAuthenticationFailure: Process completed.');
    }
}


/**
 * Connects the previously created IRC client instance.
 * Manages connection state to prevent concurrent attempts via connectIrcClient.
 * @returns {Promise<void>} Resolves on successful connection, rejects on failure.
 * @throws {Error} If the client hasn't been created first.
 */
async function connectIrcClient() {
    if (!client) {
        logger.warn('connectIrcClient called before client creation. Creating IRC client now to satisfy on-demand connect...');
        await createIrcClient(config.twitch);
    }

    // Check the general connectionAttemptPromise lock
    if (connectionAttemptPromise) {
        logger.warn('connectIrcClient: A connection attempt is already in progress (connectionAttemptPromise is set). Returning existing promise.');
        return connectionAttemptPromise;
    }
    if (client.readyState() === 'OPEN') {
        logger.info('connectIrcClient: Client is already connected.');
        return Promise.resolve();
    }

    logger.info('connectIrcClient: Initiating new IRC client connection...');
    connectionAttemptPromise = client.connect()
        .then(() => {
            logger.info('connectIrcClient: client.connect() promise resolved. Connection should be established.');
            // Note: The 'connected' event is the true confirmation of being connected.
        })
        .catch(error => {
            logger.fatal({ err: error }, 'connectIrcClient: Failed to connect to Twitch IRC during initial connect call.');
            connectionAttemptPromise = null; // Clear promise on fatal failure of this attempt
            throw error; // Re-throw to signal connection failure to the caller (e.g., bot.js)
        });

    return connectionAttemptPromise;
}

function getIrcClient() {
    if (!client) {
        throw new Error('IRC client has not been created/initialized.');
    }
    return client;
}

export { createIrcClient, connectIrcClient, getIrcClient, handleAuthenticationFailure }; // Ensure handleAuthenticationFailure is exported if used externally, though it's mostly internal.