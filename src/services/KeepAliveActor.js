// src/services/KeepAliveActor.js
import logger from '../lib/logger.js';
import { getUsersByLogin, getLiveStreams } from '../components/twitch/helixClient.js';
import LifecycleManager from './LifecycleManager.js';

/**
 * KeepAliveActor
 *
 * Manages in-process keep-alive mechanism to prevent Cloud Run from scaling down
 * when streams are active.
 *
 * Uses setInterval to periodically verify stream status and make HTTP requests
 * to keep the instance alive. This avoids the Cloud Tasks API dependency which
 * has reliability issues during cold starts.
 *
 * This is an "Actor" in the Observer-Actor pattern:
 * - Observers (Stream Poller, EventSub) detect stream state
 * - LifecycleManager maintains single source of truth for active streams
 * - KeepAliveActor responds to stream state changes by starting/stopping pings
 */
class KeepAliveActor {
    constructor() {
        this.intervalId = null;
        this.isActive = false;
        this.consecutiveFailedChecks = 0;
        this.maxFailedChecks = 3; // Require 3 consecutive failures before giving up
        this.checkIntervalMs = 60000; // Check every 60 seconds
    }

    /**
     * Start keep-alive pings
     * Called by LifecycleManager when first stream goes live
     */
    async start() {
        if (this.isActive) {
            logger.debug('KeepAliveActor: Already active, skipping start');
            return;
        }

        logger.info('KeepAliveActor: Starting in-process keep-alive checks');
        this.isActive = true;
        this.consecutiveFailedChecks = 0;

        // Start interval timer for periodic checks
        this.intervalId = setInterval(() => {
            this.performCheck().catch(err => {
                logger.error({ err }, 'KeepAliveActor: Error during periodic check');
            });
        }, this.checkIntervalMs);

        // Perform first check immediately
        await this.performCheck();

        logger.info({ intervalMs: this.checkIntervalMs }, 'KeepAliveActor: In-process keep-alive started');
    }

    /**
     * Stop keep-alive pings
     * Called by LifecycleManager when all streams end
     */
    async stop() {
        if (!this.isActive) {
            logger.debug('KeepAliveActor: Already stopped, skipping stop');
            return;
        }

        logger.info('KeepAliveActor: Stopping in-process keep-alive checks');
        this.isActive = false;
        this.consecutiveFailedChecks = 0;

        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            logger.info('KeepAliveActor: Interval timer cleared');
        }
    }

    /**
     * Perform a periodic check of stream status
     * This method:
     * 1. Verifies streams are still live (cross-checks with Twitch API)
     * 2. Cleans up phantom streams
     * 3. Decides whether to continue or stop the keep-alive actor
     * @private
     */
    async performCheck() {
        logger.debug('KeepAliveActor: Performing periodic stream check');

        if (!this.isActive) {
            logger.warn('KeepAliveActor: Check triggered but actor is not active - stopping');
            return;
        }

        // Get active streams from LifecycleManager
        const lifecycle = LifecycleManager.get();
        const activeStreams = new Set(lifecycle.getActiveStreams());

        // Cross-reference with Twitch Helix API to detect missed offline notifications
        let shouldContinue = false;
        const reasons = [];

        if (activeStreams.size > 0) {
            try {
                logger.debug(`KeepAliveActor: Verifying ${activeStreams.size} active streams against Helix API`);

                // Convert channel names to broadcaster IDs
                const channelNames = Array.from(activeStreams);
                const userData = await getUsersByLogin(channelNames);

                if (userData.length === 0) {
                    logger.warn('KeepAliveActor: Could not fetch user data from Helix API');
                } else {
                    const broadcasterIds = userData.map(u => u.id);
                    const liveStreamsData = await getLiveStreams(broadcasterIds);

                    // Build set of actually live channel names
                    const actuallyLive = new Set(
                        liveStreamsData.map(s => s.user_login.toLowerCase())
                    );

                    // Find phantom streams (in activeStreams but not actually live)
                    const phantomStreams = channelNames.filter(ch => !actuallyLive.has(ch));

                    if (phantomStreams.length > 0) {
                        logger.warn({
                            phantomStreams,
                            activeStreams: channelNames,
                            actuallyLive: Array.from(actuallyLive)
                        }, 'KeepAliveActor: Detected phantom streams - cleaning up');

                        // Remove phantom streams from LifecycleManager
                        for (const phantom of phantomStreams) {
                            await lifecycle.onStreamStatusChange(phantom, false);
                        }
                    }

                    // If there are still live streams, continue
                    if (actuallyLive.size > 0) {
                        shouldContinue = true;
                        reasons.push(`${actuallyLive.size} streams verified live: ${Array.from(actuallyLive).join(', ')}`);
                    }
                }
            } catch (error) {
                logger.error({ err: error }, 'KeepAliveActor: Error verifying streams with Helix API');
                // On error, trust the LifecycleManager state for this check
                shouldContinue = activeStreams.size > 0;
                if (shouldContinue) {
                    reasons.push(`${activeStreams.size} streams in LifecycleManager (API check failed)`);
                }
            }
        }

        // Decide whether to continue or stop
        if (shouldContinue) {
            this.consecutiveFailedChecks = 0;
            logger.info(`KeepAliveActor: Check passed - ${reasons.join('; ')}`);
        } else {
            this.consecutiveFailedChecks++;
            logger.warn(`KeepAliveActor: Check failed (${this.consecutiveFailedChecks}/${this.maxFailedChecks}) - No active streams detected`);

            if (this.consecutiveFailedChecks >= this.maxFailedChecks) {
                logger.warn(`KeepAliveActor: ${this.maxFailedChecks} consecutive failures - stopping keep-alive`);
                await this.stop();
            }
        }
    }

    /**
     * Get the current status of the keep-alive actor
     * @returns {{ isActive: boolean, consecutiveFailedChecks: number, hasActiveInterval: boolean }}
     */
    getStatus() {
        return {
            isActive: this.isActive,
            consecutiveFailedChecks: this.consecutiveFailedChecks,
            hasActiveInterval: this.intervalId !== null
        };
    }
}

export default KeepAliveActor;
