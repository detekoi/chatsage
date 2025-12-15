import config from '../config/index.js';
import logger from '../lib/logger.js';
import { getIrcClient, connectIrcClient } from '../components/twitch/ircClient.js';
import { startStreamInfoPolling } from '../components/twitch/streamInfoPoller.js';
import { startAutoChatManager } from '../components/autoChat/autoChatManager.js';
import { startAdSchedulePoller } from '../components/twitch/adSchedulePoller.js';
import { getHelixClient } from '../components/twitch/helixClient.js';
import { getContextManager } from '../components/context/contextManager.js';
import { listenForChannelChanges } from '../components/twitch/channelManager.js';

class LifecycleManager {
    constructor() {
        this.activeStreams = new Set();
        this.isMonitoring = false;
        this.streamInfoIntervalId = null;
        this.channelChangeListener = null;
        this._instance = null;
    }

    static getInstance() {
        if (!LifecycleManager._instance) {
            LifecycleManager._instance = new LifecycleManager();
        }
        return LifecycleManager._instance;
    }

    /**
     * Starts the "Observer" layer: Pollers, Context, etc.
     * This should run immediately on startup.
     */
    async startMonitoring() {
        if (this.isMonitoring) {
            logger.warn('LifecycleManager: Monitoring already started.');
            return;
        }

        logger.info('LifecycleManager: Starting monitoring layer...');

        try {
            const helixClient = getHelixClient();
            const contextManager = getContextManager();

            // 1. Start Stream Info Poller
            logger.info('LifecycleManager: Starting stream info polling...');
            this.streamInfoIntervalId = await startStreamInfoPolling(
                config.twitch.channels,
                config.app.streamInfoFetchIntervalMs,
                helixClient,
                contextManager,
                this // Pass the lifecycle manager instance to receive stream status updates
            );

            // 2. Start Auto Chat Manager
            logger.info('LifecycleManager: Starting Auto-Chat Manager...');
            await startAutoChatManager();

            // 3. Start Ad Schedule Poller
            logger.info('LifecycleManager: Starting Ad Schedule Poller...');
            await startAdSchedulePoller();

            // 4. Setup Firestore Listener (if prod)
            if (config.app.nodeEnv !== 'development') {
                logger.info('LifecycleManager: Setting up Firestore channel listener...');
                // Pass null for ircClient initially; it will be picked up by the listener or we can pass a getter
                // The original listenForChannelChanges takes ircClient. 
                // We might need to adjust listenForChannelChanges to handle lazy client, 
                // but for now let's pass the client getter or wrapper.
                // Actually, listenForChannelChanges uses ircClient to join/part.
                // We should probably defer this or let the manager handle joins.
                // For now, let's keep it as is but pass the client if available.
                const ircClient = getIrcClient();
                this.channelChangeListener = listenForChannelChanges(ircClient);
            }

            this.isMonitoring = true;
            logger.info('LifecycleManager: Monitoring layer started successfully.');

            // Initial check for active streams from the poller's first run
            await this.initializeActiveStreamsFromPoller();

        } catch (error) {
            logger.error({ err: error }, 'LifecycleManager: Failed to start monitoring layer.');
            throw error;
        }
    }

    /**
     * Populates activeStreams based on the initial poll results.
     */
    async initializeActiveStreamsFromPoller() {
        const contextManager = getContextManager();
        const channelStates = contextManager.getAllChannelStates();
        let foundLive = 0;

        for (const [channelName] of channelStates) {
            const streamContext = contextManager.getStreamContextSnapshot(channelName);
            // A stream is live if startedAt is set (not null) and game is not 'N/A'
            // Both conditions ensure we're checking current live status, not stale data
            const isLive = streamContext &&
                           streamContext.startedAt !== null &&
                           streamContext.startedAt !== 'N/A' &&
                           streamContext.game !== 'N/A' &&
                           streamContext.game !== null;

            if (isLive) {
                const login = String(channelName).toLowerCase();
                this.activeStreams.add(login);
                foundLive++;
                logger.debug(`LifecycleManager: Detected live stream: ${login} (game: ${streamContext.game}, started: ${streamContext.startedAt})`);
            }
        }

        logger.info(`LifecycleManager: Found ${foundLive} already-live streams from poller.`);
        await this.reassessConnectionState();
    }

    /**
     * Called by EventSub or Poller when a stream goes online/offline.
     * @param {string} channel - Channel name (login)
     * @param {boolean} isLive - True if online, false if offline
     */
    async onStreamStatusChange(channel, isLive) {
        const login = channel.toLowerCase();
        const wasLive = this.activeStreams.has(login);

        if (isLive) {
            this.activeStreams.add(login);
            if (!wasLive) logger.info(`LifecycleManager: Stream ${login} went ONLINE.`);
        } else {
            this.activeStreams.delete(login);
            if (wasLive) logger.info(`LifecycleManager: Stream ${login} went OFFLINE.`);
        }

        // Trigger IRC actor response
        await this.reassessConnectionState();

        // Note: Keep-alive logic removed - using min-instances=1 instead
        // Bot now stays alive continuously without needing keep-alive pings
    }

    /**
     * Decides whether the IRC client should be connected or disconnected.
     */
    async reassessConnectionState() {
        const ircClient = getIrcClient();

        // If no client yet, we can't check status, but we might need to create it.
        // Assuming createIrcClient was called in bot.js before this.

        if (!ircClient) {
            logger.warn('LifecycleManager: IRC Client not initialized yet.');
            return;
        }

        const status = ircClient.readyState();
        const isConnected = status === 'OPEN';
        const isConnecting = status === 'CONNECTING';

        const isLazyConnect = process.env.LAZY_CONNECT === '1' || process.env.LAZY_CONNECT === 'true';
        // In development, we generally want the bot present in chat even if the channel is offline.
        // In non-dev, LAZY_CONNECT controls whether we only connect when streams are active.
        const shouldBeConnected = (config.app.nodeEnv === 'development')
            ? !isLazyConnect
            : (!isLazyConnect || this.activeStreams.size > 0);

        if (shouldBeConnected) {
            if (!isConnected && !isConnecting) {
                logger.info('LifecycleManager: Connecting IRC client...');
                try {
                    await connectIrcClient();
                    // Join channels is handled by onConnected in ircEventHandlers, 
                    // but we should ensure we join the specific active ones.
                    // The onConnected handler will ask LifecycleManager for active streams.
                } catch (err) {
                    logger.error({ err }, 'LifecycleManager: Failed to connect IRC client.');
                }
            } else if (isConnected) {
                // Ensure we are joined to all active streams
                this.ensureJoinedToActiveStreams();
            }
        } else {
            // No active streams
            if (isConnected && isLazyConnect) {
                logger.info('LifecycleManager: No active streams. Disconnecting IRC client (Lazy Connect)...');
                try {
                    // Optional: Add a delay here to prevent thrashing
                    await ircClient.disconnect();
                } catch (err) {
                    logger.error({ err }, 'LifecycleManager: Failed to disconnect IRC client.');
                }
            }
        }
    }

    async ensureJoinedToActiveStreams() {
        const ircClient = getIrcClient();
        if (!ircClient || ircClient.readyState() !== 'OPEN') return;

        const joinedChannels = ircClient.getChannels().map(c => c.replace('#', '').toLowerCase());

        for (const channel of this.activeStreams) {
            if (!joinedChannels.includes(channel)) {
                logger.info(`LifecycleManager: Joining missing active channel #${channel}`);
                try {
                    await ircClient.join(`#${channel}`);
                } catch (err) {
                    logger.warn({ err, channel }, 'LifecycleManager: Failed to join channel.');
                }
            }
        }
    }

    getActiveStreams() {
        return Array.from(this.activeStreams);
    }

    // Helper to get the singleton instance easily
    static get() {
        return LifecycleManager.getInstance();
    }
}

export default LifecycleManager;
