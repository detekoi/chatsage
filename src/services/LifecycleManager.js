import config from '../config/index.js';
import logger from '../lib/logger.js';
import { startStreamInfoPolling, stopStreamInfoPolling } from '../components/twitch/streamInfoPoller.js';
import { startAutoChatManager, stopAutoChatManager } from '../components/autoChat/autoChatManager.js';
import { startTimerManager, stopTimerManager } from '../components/timers/timerManager.js';
import { startAdSchedulePoller, stopAdSchedulePoller } from '../components/twitch/adSchedulePoller.js';
import { getHelixClient } from '../components/twitch/helixClient.js';
import { getContextManager } from '../components/context/contextManager.js';
import { listenForChannelChanges } from '../components/twitch/channelManager.js';
import { onPersonaChanges } from '../components/context/personaStorage.js';
import { resetChatSession } from '../components/llm/llmClient.js';
import { getChannelNameForBroadcasterId } from '../lib/allowList.js';
import * as sharedChatManager from '../components/twitch/sharedChatManager.js';

class LifecycleManager {
    constructor() {
        this.activeStreams = new Set();
        this.isMonitoring = false;
        this.streamInfoIntervalId = null;
        this.channelChangeListener = null;
        this.personaChangeListener = null;
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

            // 2b. Start Timer Manager (timed messages)
            logger.info('LifecycleManager: Starting Timer Manager...');
            await startTimerManager();

            // 3. Start Ad Schedule Poller
            logger.info('LifecycleManager: Starting Ad Schedule Poller...');
            await startAdSchedulePoller();

            // 4. Setup Firestore Listener for channel changes
            logger.info('LifecycleManager: Setting up Firestore channel listener...');
            // listenForChannelChanges now manages EventSub subscriptions, no IRC client needed
            this.channelChangeListener = listenForChannelChanges();

            // 5. Setup Firestore Listener for persona changes
            logger.info('LifecycleManager: Setting up Firestore persona listener...');
            this.personaChangeListener = onPersonaChanges(({ twitchUserId }) => {
                // The chat session bakes the system instruction in at construction,
                // so a changed persona has to invalidate every session built from it.
                const channelName = getChannelNameForBroadcasterId(twitchUserId);
                if (channelName) {
                    resetChatSession(channelName);
                }

                // A shared session blends several personas, so one change can
                // invalidate more than one session. Sessions are few; scan them all.
                for (const [sessionId, session] of sharedChatManager.getAllSessions()) {
                    const participates = session.participants?.some(
                        p => String(p.broadcaster_user_id) === String(twitchUserId)
                    );
                    if (participates) {
                        resetChatSession(sessionId);
                    }
                }

                logger.info({ twitchUserId, channelName }, 'LifecycleManager: Persona changed, chat sessions reset');
            });

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
     * Stops the monitoring layer: unsubscribes Firestore listeners, stops pollers and managers.
     */
    stopMonitoring() {
        if (!this.isMonitoring) {
            logger.debug('LifecycleManager: Monitoring is not running.');
            return;
        }

        logger.info('LifecycleManager: Stopping monitoring layer...');

        // 1. Unsubscribe Firestore persona listener
        if (typeof this.personaChangeListener === 'function') {
            try {
                this.personaChangeListener();
            } catch (err) {
                logger.error({ err }, 'LifecycleManager: Error unsubscribing persona listener');
            }
            this.personaChangeListener = null;
        }

        // 2. Unsubscribe Firestore channel listener
        if (typeof this.channelChangeListener === 'function') {
            try {
                this.channelChangeListener();
            } catch (err) {
                logger.error({ err }, 'LifecycleManager: Error unsubscribing channel listener');
            }
            this.channelChangeListener = null;
        }

        // 3. Stop Stream Info Poller
        try {
            stopStreamInfoPolling();
            this.streamInfoIntervalId = null;
        } catch (err) {
            logger.error({ err }, 'LifecycleManager: Error stopping stream info polling');
        }

        // 4. Stop Ad Schedule Poller
        try {
            stopAdSchedulePoller();
        } catch (err) {
            logger.error({ err }, 'LifecycleManager: Error stopping ad schedule poller');
        }

        // 5. Stop Timer Manager
        try {
            stopTimerManager();
        } catch (err) {
            logger.error({ err }, 'LifecycleManager: Error stopping timer manager');
        }

        // 6. Stop Auto Chat Manager
        try {
            stopAutoChatManager();
        } catch (err) {
            logger.error({ err }, 'LifecycleManager: Error stopping auto chat manager');
        }

        this.activeStreams.clear();
        this.isMonitoring = false;
        logger.info('LifecycleManager: Monitoring layer stopped successfully.');
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

        await this.reassessConnectionState();
    }

    /**
     * No longer manages IRC connection state.
     * EventSub webhooks handle chat reception, so no connection management needed.
     * This method is kept for backward compatibility but is now a no-op.
     */
    async reassessConnectionState() {
        // With EventSub, we don't need to manage IRC connections.
        // Active stream tracking still happens via onStreamStatusChange
        // for context management and autochat purposes.
        logger.debug(`LifecycleManager: reassessConnectionState called (no-op with EventSub). Active streams: ${this.activeStreams.size}`);
    }

    /**
     * No longer needed with EventSub - was for joining IRC channels.
     * Kept as no-op for backward compatibility.
     */
    async ensureJoinedToActiveStreams() {
        // No-op: EventSub subscriptions are managed by channelManager/twitchSubs
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
