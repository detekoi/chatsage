import crypto from 'crypto';
import config from '../../config/index.js';
import logger from '../../lib/logger.js';
import { getIrcClient, connectIrcClient } from './ircClient.js';
import { isChannelAllowed } from './channelManager.js';
import { scheduleNextKeepAlivePing, deleteTask } from '../../lib/taskHelpers.js';
import { getContextManager } from '../context/contextManager.js';

// Track active streams and keep-alive tasks
const activeStreams = new Set();
let keepAliveTaskName = null;
let consecutiveFailedChecks = 0;
const MAX_FAILED_CHECKS = 3; // Require 3 consecutive failures before scaling down
const CHAT_ACTIVITY_THRESHOLD = 5 * 60 * 1000; // 5 minutes in milliseconds

/**
 * Cleans up any existing keep-alive tasks on startup to prevent orphaned tasks
 * from previous instances from interfering with the new instance.
 */
export async function cleanupKeepAliveTasks() {
    if (keepAliveTaskName) {
        logger.info('Cleaning up existing keep-alive task on startup...');
        try {
            await deleteTask(keepAliveTaskName);
            keepAliveTaskName = null;
            logger.info('Successfully cleaned up existing keep-alive task.');
        } catch (error) {
            logger.warn({ err: error }, 'Failed to cleanup existing keep-alive task (might not exist).');
            keepAliveTaskName = null; // Reset anyway
        }
    }
    
    // Reset consecutive failed checks on startup
    consecutiveFailedChecks = 0;
    logger.debug('Reset consecutive failed checks counter on startup.');
}

/**
 * Initializes streams that are already live when the bot starts up.
 * This handles the case where streams are live before EventSub subscriptions are established.
 */
export async function initializeActiveStreamsFromPoller() {
    logger.info('Checking for streams that are already live on startup...');
    
    const contextManager = getContextManager();
    const channelStates = contextManager.getAllChannelStates();
    let foundLiveStreams = 0;
    
    for (const [channelName] of channelStates) {
        const context = contextManager.getContextForLLM(channelName, 'system', 'startup-check');
        if (context && context.streamGame && context.streamGame !== 'N/A' && context.streamGame !== null) {
            logger.info(`Found ${channelName} already live on startup - adding to activeStreams`);
            activeStreams.add(channelName);
            foundLiveStreams++;
        }
    }
    
    if (foundLiveStreams > 0) {
        logger.info(`Added ${foundLiveStreams} already-live streams to activeStreams on startup`);
        
        // Start keep-alive pings if we found live streams but no task is scheduled yet
        if (!keepAliveTaskName) {
            try {
                logger.info('Starting keep-alive pings for streams that were already live');
                keepAliveTaskName = await scheduleNextKeepAlivePing(240); // Start in 4 minutes
            } catch (error) {
                logger.error({ err: error }, 'Failed to start keep-alive pings for pre-existing streams');
            }
        }
    } else {
        logger.info('No streams found live on startup');
    }
}

/**
 * Handles the keep-alive ping from Cloud Tasks
 * This is called by the /keep-alive endpoint
 */
export async function handleKeepAlivePing() {
    logger.info('Keep-alive ping received.');

    // Validate EventSub active streams against stream poller data
    const contextManager = getContextManager();
    const channelStates = contextManager.getAllChannelStates();
    const actuallyActiveStreams = new Set();
    
    // Check which EventSub streams are actually live according to the poller
    for (const streamName of activeStreams) {
        const context = contextManager.getContextForLLM(streamName, 'system', 'keep-alive-validation');
        if (context && context.streamGame && context.streamGame !== 'N/A' && context.streamGame !== null) {
            actuallyActiveStreams.add(streamName);
        } else {
            logger.warn(`EventSub thinks ${streamName} is live, but poller shows it's offline. Removing from active streams.`);
        }
    }
    
    // Clean up phantom EventSub entries
    activeStreams.clear();
    actuallyActiveStreams.forEach(stream => activeStreams.add(stream));

    // Check for recent chat activity and poller-detected active streams
    let recentChatActivity = false;
    let pollerActiveCount = 0;
    const activeChannelsFromPoller = [];
    let recentChatDetails = [];

    for (const [channelName, state] of channelStates) {
        // Check for recent chat messages
        if (state.chatHistory && state.chatHistory.length > 0) {
            const lastMessage = state.chatHistory[state.chatHistory.length - 1];
            // Ensure timestamp is a Date object
            const messageTimestamp = lastMessage.timestamp instanceof Date ? lastMessage.timestamp : new Date(lastMessage.timestamp);
            const timeSinceLastMessage = Date.now() - messageTimestamp.getTime();
            
            if (timeSinceLastMessage < CHAT_ACTIVITY_THRESHOLD) {
                recentChatActivity = true;
                recentChatDetails.push(`${channelName} (${Math.round(timeSinceLastMessage / 1000)}s ago)`);
                logger.debug(`Recent chat activity detected in ${channelName} (${Math.round(timeSinceLastMessage / 1000)}s ago)`);
            }
        }

        // Check poller context - a stream is considered active if it has valid game info
        const context = contextManager.getContextForLLM(channelName, 'system', 'keep-alive-check');
        if (context && context.streamGame && context.streamGame !== 'N/A' && context.streamGame !== null) {
            pollerActiveCount++;
            activeChannelsFromPoller.push(channelName);
            // Add channels found live by poller to activeStreams if missing from EventSub
            if (!activeStreams.has(channelName)) {
                logger.info(`Adding ${channelName} to activeStreams - detected as live by poller but missing from EventSub`);
                activeStreams.add(channelName);
            }
        }
    }

    // Check validated EventSub streams first
    if (activeStreams.size > 0) {
        logger.info(`Keep-alive check passed: ${activeStreams.size} stream(s) are active (EventSub: ${actuallyActiveStreams.size}, Poller: ${pollerActiveCount}).`);
        consecutiveFailedChecks = 0; // Reset failure counter
        try {
            keepAliveTaskName = await scheduleNextKeepAlivePing(240); // 4 minutes
        } catch (error) {
            logger.error({ err: error }, 'Failed to schedule next keep-alive ping');
        }
        return;
    }

    // Determine if we should keep the instance alive based on activity
    const shouldStayAlive = recentChatActivity || pollerActiveCount > 0;

    if (shouldStayAlive) {
        consecutiveFailedChecks = 0; // Reset failure counter
        let reason = [];
        if (recentChatActivity) reason.push(`recent chat activity in: ${recentChatDetails.join(', ')}`);
        if (pollerActiveCount > 0) reason.push(`${pollerActiveCount} stream(s) live according to poller: ${activeChannelsFromPoller.join(', ')}`);
        
        logger.info(`Keep-alive check passed: ${reason.join(' and ')}.`);
        
        try {
            keepAliveTaskName = await scheduleNextKeepAlivePing(240); // 4 minutes
        } catch (error) {
            logger.error({ err: error }, 'Failed to schedule next keep-alive ping');
        }
    } else {
        consecutiveFailedChecks++;
        logger.warn(`Keep-alive check failed (${consecutiveFailedChecks}/${MAX_FAILED_CHECKS}): No active streams or recent chat activity detected.`);
        logger.debug(`Debug info - EventSub streams: ${Array.from(activeStreams).join(', ') || 'none'}, Poller active: ${pollerActiveCount}, Recent chat: ${recentChatActivity}`);

        if (consecutiveFailedChecks >= MAX_FAILED_CHECKS) {
            logger.warn(`${MAX_FAILED_CHECKS} consecutive failed keep-alive checks. Allowing instance to scale down.`);
            if (keepAliveTaskName) {
                try {
                    await deleteTask(keepAliveTaskName);
                    keepAliveTaskName = null;
                } catch (error) {
                    logger.error({ err: error }, 'Failed to delete final keep-alive task.');
                }
            }
        } else {
            // Schedule next check even after failure (until max failures reached)
            try {
                keepAliveTaskName = await scheduleNextKeepAlivePing(240); // 4 minutes
            } catch (error) {
                logger.error({ err: error }, 'Failed to schedule next keep-alive ping after failure');
            }
        }
    }
}

/**
 * Manually clear phantom EventSub entries (useful for debugging/cleanup)
 * @param {string[]} streamNames - Optional array of specific streams to remove, or empty to clear all
 */
export function clearPhantomEventSubEntries(streamNames = []) {
    if (streamNames.length === 0) {
        logger.info(`Clearing all phantom EventSub entries. Previously tracking: ${Array.from(activeStreams).join(', ')}`);
        activeStreams.clear();
    } else {
        streamNames.forEach(streamName => {
            if (activeStreams.has(streamName)) {
                activeStreams.delete(streamName);
                logger.info(`Removed phantom EventSub entry for: ${streamName}`);
            }
        });
    }
    logger.info(`EventSub now tracking ${activeStreams.size} active streams: ${Array.from(activeStreams).join(', ') || 'none'}`);
}

function verifySignature(req, rawBody) {
    // Allow bypassing signature verification for local development
    const bypass = process.env.EVENTSUB_BYPASS === '1' || process.env.EVENTSUB_BYPASS === 'true';
    if (bypass) {
        logger.warn('[DEV] EVENTSUB_BYPASS enabled - skipping signature verification');
        return true;
    }

    const secret = config.twitch.eventSubSecret;
    const messageId = req.headers['twitch-eventsub-message-id'];
    const timestamp = req.headers['twitch-eventsub-message-timestamp'];
    const signature = req.headers['twitch-eventsub-message-signature'];
    
    // --- Start of new debug logging ---
    logger.info('--- Verifying EventSub Signature ---');
    logger.info({ messageId }, 'Received Message ID');
    logger.info({ timestamp }, 'Received Timestamp');
    logger.info({ signature }, 'Received Signature');
    logger.info('Received Raw Body: ' + rawBody.toString('utf8'));
    // --- End of new debug logging ---
    
    if (!secret || !messageId || !timestamp || !signature) {
        logger.warn('A required header or secret for signature verification is missing.');
        return false;
    }

    const hmacMessage = messageId + timestamp + rawBody;
    const hmac = 'sha256=' + crypto.createHmac('sha256', secret).update(hmacMessage).digest('hex');
    
    logger.info({ hmac }, 'Generated HMAC');

    const isSignatureValid = crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature));
    logger.info({ isSignatureValid }, 'Signature verification result');
    
    return isSignatureValid;
}

export async function eventSubHandler(req, res, rawBody) {
    if (!verifySignature(req, rawBody)) {
        logger.warn('⚠️ Bad EventSub signature');
        res.writeHead(403).end();
        return;
    }

    const notification = JSON.parse(rawBody);
    const messageType = req.headers['twitch-eventsub-message-type'];

    if (messageType !== 'webhook_callback_verification') res.writeHead(200).end();

    if (messageType === 'webhook_callback_verification') {
        logger.info('✅ EventSub webhook verification challenge received');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(notification.challenge);
        logger.info('✅ EventSub webhook verification challenge responded');
        return;
    }

    if (messageType === 'notification') {
        const { subscription, event } = notification;

        if (subscription.type === 'stream.online') {
            const { broadcaster_user_name } = event;
            logger.info(`📡 ${broadcaster_user_name} just went live — ensuring bot is active...`);

            // Enforce allow-list: ignore online events for disallowed channels
            const allowed = await isChannelAllowed(broadcaster_user_name);
            if (!allowed) {
                logger.warn(`[EventSub] ${broadcaster_user_name} is not on the allow-list or not active. Ignoring stream.online event.`);
                return;
            }

            // Add to active streams
            activeStreams.add(broadcaster_user_name);

            // Start keep-alive pings if this is the first stream to go live
            if (activeStreams.size === 1 && !keepAliveTaskName) {
                try {
                    logger.info('First stream went live - starting keep-alive pings');
                    keepAliveTaskName = await scheduleNextKeepAlivePing(240); // Start in 4 minutes
                } catch (error) {
                    logger.error({ err: error }, 'Failed to start keep-alive pings');
                }
            }

            const isLazyConnect = process.env.LAZY_CONNECT === '1' || process.env.LAZY_CONNECT === 'true';
            if (isLazyConnect) {
                try {
                    logger.info('EventSub triggered - initializing IRC connection...');
                    
                    // First connect to IRC if not already connected
                    await connectIrcClient();
                    logger.info('IRC connection established from EventSub trigger');
                    
                    // Then join the channel
                    const ircClient = getIrcClient();
                    await ircClient.join(`#${broadcaster_user_name}`);
                    logger.info(`Joined channel #${broadcaster_user_name} via EventSub trigger`);
                } catch (error) {
                    logger.error({ err: error }, 'Failed to establish IRC connection or join channel from EventSub');
                    throw error;
                }
            }
        }

        if (subscription.type === 'stream.offline') {
            const { broadcaster_user_name } = event;
            logger.info(`🔌 ${broadcaster_user_name} went offline.`);

            // Remove from active streams
            activeStreams.delete(broadcaster_user_name);

            // Clear the stream context to ensure the poller and keep-alive know the stream is offline
            getContextManager().clearStreamContext(broadcaster_user_name);
            
            // If no more streams are active, stop keep-alive pings
            if (activeStreams.size === 0 && keepAliveTaskName) {
                try {
                    logger.info('Last stream went offline - stopping keep-alive pings to allow scale-down');
                    await deleteTask(keepAliveTaskName);
                    keepAliveTaskName = null;
                } catch (error) {
                    logger.error({ err: error }, 'Failed to stop keep-alive pings');
                }
            }
            
            try {
                const ircClient = getIrcClient();
                if (ircClient && ircClient.readyState() === 'OPEN') {
                    const channelToPart = `#${broadcaster_user_name}`;
                    logger.info(`[EventSub] Attempting to part channel: ${channelToPart}`);
                    await ircClient.part(channelToPart);
                } else {
                    logger.warn(`[EventSub] Received offline event for ${broadcaster_user_name}, but IRC client is not connected. No action taken.`);
                }
            } catch (error) {
                logger.error({ err: error, channel: broadcaster_user_name }, 'Error trying to part channel via EventSub offline notification.');
            }
        }
    }
}