import logger from '../../lib/logger.js';
import config from '../../config/index.js';
import {
    syncManagedChannelsWithIrc,
    getActiveManagedChannels,
    listenForChannelChanges
} from './channelManager.js';
import { startStreamInfoPolling, stopStreamInfoPolling } from './streamInfoPoller.js';
import { startAutoChatManager } from '../autoChat/autoChatManager.js';
import { initializeActiveStreamsFromPoller } from './eventsub.js';
import { startAdSchedulePoller, stopAdSchedulePoller } from './adSchedulePoller.js';
import { CHANNEL_SYNC_INTERVAL_MS } from '../../constants/botConstants.js';

/**
 * Creates IRC event handlers with the necessary dependencies.
 * @param {Object} deps - Dependencies object
 * @param {Object} deps.helixClient - Helix API client
 * @param {Object} deps.contextManager - Context manager instance
 * @param {Function} deps.setFullyInitialized - Function to mark bot as fully initialized
 * @param {Function} deps.getStreamInfoIntervalId - Function to get current stream info interval ID
 * @param {Function} deps.setStreamInfoIntervalId - Function to set stream info interval ID
 * @param {Function} deps.getChannelChangeListener - Function to get current channel change listener
 * @param {Function} deps.setChannelChangeListener - Function to set channel change listener
 * @param {Function} deps.getChannelSyncIntervalId - Function to get channel sync interval ID
 * @param {Function} deps.setChannelSyncIntervalId - Function to set channel sync interval ID
 * @returns {Object} Event handlers for IRC client
 */
export function createIrcEventHandlers(deps) {
    const {
        helixClient,
        contextManager,
        setFullyInitialized,
        getStreamInfoIntervalId,
        setStreamInfoIntervalId,
        getChannelChangeListener,
        setChannelChangeListener,
        getChannelSyncIntervalId,
        setChannelSyncIntervalId
    } = deps;

    /**
     * Handler for IRC 'connected' event
     */
    async function onConnected(address, port) {
        logger.info(`Successfully connected to Twitch IRC: ${address}:${port}`);

        // --- Conditional Firestore Syncing/Listening ---
        if (config.app.nodeEnv !== 'development') {
            logger.info('Non-dev environment: Setting up Firestore channel listener and sync.');

            // 1. Set up listener for channel changes
            if (!getChannelChangeListener()) {
                logger.info('Setting up listener for channel changes...');
                const listener = listenForChannelChanges(this); // 'this' is the ircClient
                setChannelChangeListener(listener);
            }

            // 2. Sync channels from Firestore with IRC (Initial Sync after connect)
            try {
                logger.info('Syncing channels from Firestore with IRC...');
                const syncResult = await syncManagedChannelsWithIrc(this);
                logger.info(`Channels synced: ${syncResult.joined.length} joined, ${syncResult.parted.length} parted`);

                // Update config again after sync if needed
                const activeChannels = await getActiveManagedChannels();
                config.twitch.channels = activeChannels.map(ch => ch.toLowerCase());
                logger.info(`Updated config with ${config.twitch.channels.length} active channels post-sync.`);
            } catch (error) {
                logger.error({ err: error }, 'Error syncing channels from Firestore post-connect.');
            }

            // 3. Set up recurring channel sync
            if (!getChannelSyncIntervalId()) {
                const intervalId = setInterval(async () => {
                    try {
                        if (config.app.nodeEnv !== 'development') { // Double check env inside interval
                            logger.info('Running scheduled channel sync...');
                            const syncResult = await syncManagedChannelsWithIrc(this);
                            if (syncResult.joined.length > 0 || syncResult.parted.length > 0) {
                                const activeChannels = await getActiveManagedChannels();
                                config.twitch.channels = activeChannels.map(ch => ch.toLowerCase());
                                logger.info(`Updated config with ${config.twitch.channels.length} active channels after scheduled sync.`);
                            }
                        }
                    } catch (error) {
                        logger.error({ err: error }, 'Error during scheduled channel sync.');
                    }
                }, CHANNEL_SYNC_INTERVAL_MS);

                setChannelSyncIntervalId(intervalId);
                logger.info(`Scheduled channel sync every ${CHANNEL_SYNC_INTERVAL_MS / 60000} minutes.`);
            } else {
                logger.warn('Channel sync interval already scheduled; skipping re-schedule.');
            }
        } else {
            logger.info('Development mode: Skipping Firestore channel listener setup and periodic sync.');
        }
        // --- End Conditional Syncing/Listening ---

        // Start stream info polling (skip if already started in LAZY_CONNECT mode)
        if (!getStreamInfoIntervalId()) {
            logger.info(`Starting stream info polling every ${config.app.streamInfoFetchIntervalMs / 1000}s...`);
            try {
                // Await first poll to complete so context manager is populated
                const intervalId = await startStreamInfoPolling(
                    config.twitch.channels,
                    config.app.streamInfoFetchIntervalMs,
                    helixClient,
                    contextManager
                );
                setStreamInfoIntervalId(intervalId);
                logger.info('Stream info polling first cycle complete');
            } catch (err) {
                logger.error({ err }, 'Failed to start stream info polling');
            }
        } else {
            logger.info('Stream info polling already running (started in LAZY_CONNECT mode)');
        }

        // Start Auto-Chat manager after polling begins
        try {
            await startAutoChatManager();
            logger.info('Auto-Chat Manager started.');
        } catch (err) {
            logger.error({ err }, 'Failed to start Auto-Chat Manager');
        }

        try {
            await startAdSchedulePoller();
            logger.info('Ad Schedule Poller started.');
        } catch (err) {
            logger.error({ err }, 'Failed to start Ad Schedule Poller');
        }

        // After stream polling completes first cycle, check for streams that are already live
        try {
            await initializeActiveStreamsFromPoller();
            // Mark as fully initialized after all setup is complete
            setFullyInitialized(true);
            logger.info('Bot is now fully initialized and ready to handle traffic');
        } catch (error) {
            logger.error({ err: error }, 'Error initializing active streams from poller');
            setFullyInitialized(true); // Mark as initialized anyway
        }
    }

    /**
     * Handler for IRC 'disconnected' event
     */
    function onDisconnected(reason) {
        logger.warn(`Disconnected from Twitch IRC: ${reason || 'Unknown reason'}`);

        const streamInfoIntervalId = getStreamInfoIntervalId();
        if (streamInfoIntervalId) {
            stopStreamInfoPolling(streamInfoIntervalId);
        }

        try {
            stopAdSchedulePoller();
        } catch (e) {
            /* ignore */
        }

        const channelSyncIntervalId = getChannelSyncIntervalId();
        if (channelSyncIntervalId) {
            clearInterval(channelSyncIntervalId);
            setChannelSyncIntervalId(null);
            logger.info('Cleared channel sync interval on disconnect.');
        }

        // Clean up Firestore listener ONLY if it was started
        if (config.app.nodeEnv !== 'development') {
            const listener = getChannelChangeListener();
            if (listener) {
                logger.info('Cleaning up channel change listener on disconnect...');
                listener();
                setChannelChangeListener(null);
            }
        }
    }

    /**
     * Handler for IRC 'connecting' event
     */
    function onConnecting(address, port) {
        logger.info(`Connecting to Twitch IRC at ${address}:${port}...`);
    }

    /**
     * Handler for IRC 'logon' event
     */
    function onLogon() {
        logger.info('Successfully logged on to Twitch IRC.');
    }

    /**
     * Handler for IRC 'join' event
     */
    function onJoin(channel, username, self) {
        if (self) {
            logger.info(`Joined channel: ${channel}`);
        }
    }

    return {
        onConnected,
        onDisconnected,
        onConnecting,
        onLogon,
        onJoin
    };
}
