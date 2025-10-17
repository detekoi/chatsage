import crypto from 'crypto';
import config from '../../config/index.js';
import logger from '../../lib/logger.js';
import { getIrcClient, connectIrcClient } from './ircClient.js';
import { isChannelAllowed, syncChannelWithIrc } from './channelManager.js';
import { scheduleNextKeepAlivePing, deleteTask } from '../../lib/taskHelpers.js';
import { getContextManager } from '../context/contextManager.js';
import { getChannelAutoChatConfig } from '../context/autoChatStorage.js';
import { enqueueMessage } from '../../lib/ircSender.js';
import { notifyStreamOnline, notifyFollow, notifySubscription, notifyRaid, notifyAdBreak, startAutoChatManager } from '../autoChat/autoChatManager.js';
import { getLiveStreams, getUsersByLogin, getHelixClient } from './helixClient.js';
import { startStreamInfoPolling } from './streamInfoPoller.js';
import * as sharedChatManager from './sharedChatManager.js';

// Track active streams and keep-alive tasks
const activeStreams = new Set();
let keepAliveTaskName = null;
let lazyConnectInitialized = false; // Track if stream poller and auto-chat have been started in lazy mode
// eslint-disable-next-line no-unused-vars
let streamInfoIntervalId = null; // Store the interval ID for cleanup (reserved for future use)
let consecutiveFailedChecks = 0;
const MAX_FAILED_CHECKS = 3; // Require 3 consecutive failures before scaling down
const CHAT_ACTIVITY_THRESHOLD = 5 * 60 * 1000; // 5 minutes in milliseconds

// Idempotency and replay protection (in-memory window)
const processedEventIds = new Map(); // messageId -> timestamp(ms)
const TEN_MINUTES_MS = 10 * 60 * 1000;

function pruneOldProcessedIds(nowTs) {
    for (const [id, ts] of processedEventIds) {
        if (nowTs - ts > TEN_MINUTES_MS) {
            processedEventIds.delete(id);
        }
    }
}

function shouldProcessEvent(req) {
    const messageId = req.headers['twitch-eventsub-message-id'];
    const timestampHeader = req.headers['twitch-eventsub-message-timestamp'];
    if (!messageId || !timestampHeader) return false;
    const nowTs = Date.now();
    const msgTs = Date.parse(timestampHeader);
    if (Number.isFinite(msgTs) && (nowTs - msgTs) > TEN_MINUTES_MS) {
        logger.warn({ messageId, timestampHeader }, 'Dropping EventSub message older than 10 minutes (replay guard)');
        return false;
    }
    if (processedEventIds.has(messageId)) {
        logger.warn({ messageId }, 'Dropping duplicate EventSub message (already processed)');
        return false;
    }
    // Record and prune
    processedEventIds.set(messageId, nowTs);
    if (processedEventIds.size > 1000) pruneOldProcessedIds(nowTs);
    return true;
}

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
 * Uses context manager (populated by stream poller) as single source of truth.
 */
export async function initializeActiveStreamsFromPoller() {
    logger.info('Checking for streams that are already live on startup (from poller context)...');

    const contextManager = getContextManager();
    const channelStates = contextManager.getAllChannelStates();
    let foundLiveStreams = 0;

    for (const [channelName] of channelStates) {
        const context = contextManager.getContextForLLM(channelName, 'system', 'startup-check');
        if (context && context.streamGame && context.streamGame !== 'N/A' && context.streamGame !== null) {
            const login = String(channelName).toLowerCase();
            logger.info(`Found ${login} already live on startup (game: ${context.streamGame}) - adding to activeStreams`);
            activeStreams.add(login);
            foundLiveStreams++;

            // If LAZY_CONNECT is enabled, ensure IRC connection and join the live channel
            const isLazyConnect = process.env.LAZY_CONNECT === '1' || process.env.LAZY_CONNECT === 'true';
            if (isLazyConnect) {
                try {
                    const irc = getIrcClient();
                    const state = irc?.readyState?.() || 'CLOSED';
                    if (state !== 'OPEN' && state !== 'CONNECTING') {
                        logger.info(`[Startup Live] IRC not connected (state=${state}). Connecting due to live channel ${channelName}...`);
                        await connectIrcClient();
                        logger.info('[Startup Live] IRC connection established.');
                    } else {
                        logger.info(`[Startup Live] IRC already ${state}. Proceeding to join #${login}.`);
                    }
                    const client = getIrcClient();
                    try {
                        await client.join(`#${login}`);
                        logger.info(`[Startup Live] Joined channel #${login} (live with ${context.streamGame})`);
                    } catch (joinErr) {
                        // tmi.js sometimes times out even when join succeeds - log but don't fail
                        logger.warn({ err: joinErr, channel: login }, '[Startup Live] Join command timeout (may still succeed) - tmi.js quirk');
                    }
                } catch (err) {
                    logger.error({ err, channel: login }, '[Startup Live] Failed to connect to IRC from live stream detection.');
                }
            }
        }
    }

    if (foundLiveStreams > 0) {
        logger.info(`Added ${foundLiveStreams} already-live streams to activeStreams on startup`);

        // Start keep-alive pings if we found live streams but no task is scheduled yet
        if (!keepAliveTaskName) {
            try {
                logger.info('Starting keep-alive pings for streams that were already live');
                keepAliveTaskName = await scheduleNextKeepAlivePing(360); // Start in 6 minutes
            } catch (error) {
                logger.error({ err: error }, 'Failed to start keep-alive pings for pre-existing streams');
            }
        }
    } else {
        logger.info('No streams found live on startup');
    }
}

/**
 * Synchronize live channels detected by the poller with IRC join state without re-initializing.
 * - Uses context manager stream info to detect live channels
 * - Ensures joined using channelManager's syncChannelWithIrc (idempotent)
 * - Updates activeStreams for keep-alive decisions
 */
async function syncLiveChannels() {
    try {
        const contextManager = getContextManager();
        const channelStates = contextManager.getAllChannelStates();
        const ircClient = getIrcClient();
        const synced = [];

        for (const [channelName] of channelStates) {
            const login = String(channelName).toLowerCase();
            const ctx = contextManager.getContextForLLM(login, 'system', 'keep-alive-sync');
            const isLive = ctx && ctx.streamGame && ctx.streamGame !== 'N/A' && ctx.streamGame !== null;
            if (isLive) {
                if (!activeStreams.has(login)) {
                    logger.info(`[Sync] Marking ${login} live based on poller context.`);
                }
                activeStreams.add(login);
                if (ircClient) {
                    try {
                        const changed = await syncChannelWithIrc(ircClient, login, true);
                        if (changed) synced.push(channelName);
                    } catch (err) {
                        logger.warn({ err, channel: login }, '[Sync] Failed to ensure IRC join via syncChannelWithIrc.');
                    }
                }
            }
        }

        if (synced.length > 0) {
            logger.info(`[Sync] Ensured IRC joined for: ${synced.join(', ')}`);
        }
    } catch (e) {
        logger.warn({ err: e }, '[Sync] syncLiveChannels encountered an error. Continuing.');
    }
}

/**
 * Handles the keep-alive ping from Cloud Tasks
 * This is called by the /keep-alive endpoint
 */
export async function handleKeepAlivePing() {
    logger.info('Keep-alive ping received.');

    // Perform a lightweight synchronization instead of startup initialization
    await syncLiveChannels();

    // Verification step: Cross-reference activeStreams with Twitch Helix API to detect missed offline notifications
    if (activeStreams.size > 0) {
        try {
            logger.debug(`[Keep-Alive] Verifying ${activeStreams.size} active streams against Helix API...`);

            // Convert channel names to broadcaster IDs
            const channelNames = Array.from(activeStreams);
            const userData = await getUsersByLogin(channelNames);

            if (userData.length === 0) {
                logger.warn(`[Keep-Alive] Could not find any user data for ${channelNames.length} channels. Clearing activeStreams.`);
                activeStreams.clear();
            } else {
                const idToChannel = new Map(userData.map(user => [user.id, user.login]));
                const broadcasterIds = Array.from(idToChannel.keys());

                // Query live streams from Helix API (ground truth)
                const liveStreams = await getLiveStreams(broadcasterIds);
                const liveStreamUserIds = new Set(liveStreams.map(stream => stream.user_id));

                // Check for phantom streams (in activeStreams but not live according to API)
                const phantomStreams = [];
                for (const [broadcasterId, channelName] of idToChannel) {
                    const login = String(channelName).toLowerCase();
                    if (!liveStreamUserIds.has(broadcasterId)) {
                        phantomStreams.push(login);
                    }
                }

                // Remove phantom streams and log discrepancies
                if (phantomStreams.length > 0) {
                    logger.warn(`[Keep-Alive] Phantom streams detected (missed offline notifications): ${phantomStreams.join(', ')}. EventSub state is out of sync. Forcing removal.`);

                    phantomStreams.forEach(streamName => {
                        const login = String(streamName).toLowerCase();
                        activeStreams.delete(login);
                        logger.warn(`[Keep-Alive] Removed phantom stream: ${login}. Stream.offline EventSub notification was likely missed.`);

                        // Clear the stream context to ensure consistency
                        getContextManager().clearStreamContext(login);
                    });

                    logger.info(`[Keep-Alive] Verification complete. Removed ${phantomStreams.length} phantom streams. ${activeStreams.size} streams remain active.`);
                } else {
                    logger.debug(`[Keep-Alive] All ${activeStreams.size} streams verified as live by Helix API.`);
                }
            }
        } catch (error) {
            logger.warn({ err: error }, '[Keep-Alive] Failed to verify active streams against Helix API. Continuing with existing state.');
        }
    }

    const contextManager = getContextManager();
    const channelStates = contextManager.getAllChannelStates();

    // Check for recent chat activity and poller-detected active streams
    let recentChatActivity = false;
    let pollerActiveCount = 0;
    const activeChannelsFromPoller = [];
    let recentChatDetails = [];

    for (const [channelName, state] of channelStates) {
        const login = String(channelName).toLowerCase();
        // Check for recent chat messages
        if (state.chatHistory && state.chatHistory.length > 0) {
            const lastMessage = state.chatHistory[state.chatHistory.length - 1];
            // Ensure timestamp is a Date object
            const messageTimestamp = lastMessage.timestamp instanceof Date ? lastMessage.timestamp : new Date(lastMessage.timestamp);
            const timeSinceLastMessage = Date.now() - messageTimestamp.getTime();
            
            if (timeSinceLastMessage < CHAT_ACTIVITY_THRESHOLD) {
                recentChatActivity = true;
                recentChatDetails.push(`${login} (${Math.round(timeSinceLastMessage / 1000)}s ago)`);
                logger.debug(`Recent chat activity detected in ${login} (${Math.round(timeSinceLastMessage / 1000)}s ago)`);
            }
        }

        // Check poller context - a stream is considered active if it has valid game info
        const context = contextManager.getContextForLLM(login, 'system', 'keep-alive-check');
        if (context && context.streamGame && context.streamGame !== 'N/A' && context.streamGame !== null) {
            pollerActiveCount++;
            activeChannelsFromPoller.push(login);
            // Add channels found live by poller to activeStreams if missing from EventSub
            if (!activeStreams.has(login)) {
                logger.info(`Adding ${login} to activeStreams - detected as live by poller but missing from EventSub`);
                activeStreams.add(login);
            }
        }
    }

    // Determine if we should keep the instance alive.
    // We stay alive if EventSub thinks a stream is active, OR if the poller sees an active stream,
    // OR if there has been recent chat activity.
    const hasEventSubActive = activeStreams.size > 0;
    let shouldStayAlive = hasEventSubActive || pollerActiveCount > 0 || recentChatActivity;

    // Fallback: If everything looks inactive, do a direct Helix check once to avoid false negatives.
    if (!shouldStayAlive) {
        try {
            const channelsToPoll = await contextManager.getChannelsForPolling();
            if (channelsToPoll.length > 0) {
                const idToChannel = new Map(channelsToPoll.map(c => [c.broadcasterId, c.channelName]));
                const liveStreams = await getLiveStreams(channelsToPoll.map(c => c.broadcasterId));
                if (liveStreams && liveStreams.length > 0) {
                    const newlyDetected = [];
                    for (const stream of liveStreams) {
            const channelName = idToChannel.get(stream.user_id);
            const login = channelName ? String(channelName).toLowerCase() : null;
            if (login && !activeStreams.has(login)) {
                activeStreams.add(login);
                newlyDetected.push(login);
                        }
                    }
                    if (newlyDetected.length > 0) {
                        logger.info(`Helix fallback detected live streams: ${newlyDetected.join(', ')}. Preventing premature scale-down.`);
                        pollerActiveCount = new Set([...(activeChannelsFromPoller || []), ...newlyDetected]).size;
                        shouldStayAlive = true;
                    }
                }
            }
        } catch (fallbackErr) {
            logger.warn({ err: fallbackErr }, 'Helix fallback live-check during keep-alive failed.');
        }
    }

    if (shouldStayAlive) {
        consecutiveFailedChecks = 0; // Reset failure counter
        const reasons = [];
        if (hasEventSubActive) reasons.push(`${activeStreams.size} stream(s) active via EventSub: ${Array.from(activeStreams).join(', ')}`);
        if (pollerActiveCount > 0) reasons.push(`${pollerActiveCount} stream(s) live via poller: ${activeChannelsFromPoller.join(', ')}`);
        if (recentChatActivity) reasons.push(`recent chat in: ${recentChatDetails.join(', ')}`);

        logger.info(`Keep-alive check passed: ${reasons.join(' and ')}.`);
        
        try {
            keepAliveTaskName = await scheduleNextKeepAlivePing(360); // 6 minutes
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
                keepAliveTaskName = await scheduleNextKeepAlivePing(360); // 6 minutes
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
        if (!shouldProcessEvent(req)) {
            return; // Already responded 200 above; just ignore processing
        }
        const { subscription, event } = notification;

        if (subscription.type === 'stream.online') {
            const { broadcaster_user_name } = event;
            const login = String(broadcaster_user_name).toLowerCase();
            logger.info(`📡 ${login} just went live — ensuring bot is active...`);

            // Enforce allow-list: ignore online events for disallowed channels
            const allowed = await isChannelAllowed(login);
            if (!allowed) {
                logger.warn(`[EventSub] ${broadcaster_user_name} is not on the allow-list or not active. Ignoring stream.online event.`);
                return;
            }

            // Add to active streams
            activeStreams.add(login);

            // Start keep-alive pings if this is the first stream to go live
            if (activeStreams.size === 1 && !keepAliveTaskName) {
                try {
                    logger.info('First stream went live - starting keep-alive pings');
                    keepAliveTaskName = await scheduleNextKeepAlivePing(360); // Start in 6 minutes
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

                    // Initialize stream poller and auto-chat on first lazy connect (one-time setup)
                    if (!lazyConnectInitialized) {
                        logger.info('[LAZY_CONNECT] First stream.online event - initializing stream poller and auto-chat...');

                        try {
                            const contextManager = getContextManager();
                            const helixClient = getHelixClient();

                            // Start stream info polling
                            logger.info('[LAZY_CONNECT] Starting stream info polling...');
                            streamInfoIntervalId = startStreamInfoPolling(
                                config.twitch.channels,
                                config.app.streamInfoFetchIntervalMs,
                                helixClient,
                                contextManager
                            );

                            // Start auto-chat manager
                            logger.info('[LAZY_CONNECT] Starting Auto-Chat Manager...');
                            await startAutoChatManager();

                            // Wait for poller to populate stream context before initializing active streams
                            setTimeout(async () => {
                                try {
                                    logger.info('[LAZY_CONNECT] Initializing active streams from poller...');
                                    await initializeActiveStreamsFromPoller();
                                    logger.info('[LAZY_CONNECT] Bot fully initialized in lazy connect mode');
                                } catch (error) {
                                    logger.error({ err: error }, '[LAZY_CONNECT] Error during active streams initialization');
                                }
                            }, 10000); // Wait 10 seconds for poller to run

                            lazyConnectInitialized = true;
                            logger.info('[LAZY_CONNECT] ✓ Stream poller and auto-chat initialized successfully');
                        } catch (error) {
                            logger.error({ err: error }, '[LAZY_CONNECT] Failed to initialize stream poller or auto-chat');
                        }
                    }

                    // Then join the channel (with timeout handling)
                    const ircClient = getIrcClient();
                    try {
                        await ircClient.join(`#${login}`);
                        logger.info(`Joined channel #${login} via EventSub trigger`);
                    } catch (joinError) {
                        // tmi.js sometimes times out even when join succeeds - log but don't fail
                        logger.warn({ err: joinError, channel: login }, 'Join command timeout (may still succeed) - tmi.js quirk');
                    }
                } catch (error) {
                    logger.error({ err: error }, 'Failed to establish IRC connection from EventSub');
                    // Don't throw - allow bot to continue even if join fails
                }
            }
            // Inform AutoChatManager so it can greet once
            try { notifyStreamOnline(login); } catch (e) { /* ignore */ }
        }

        if (subscription.type === 'stream.offline') {
            const { broadcaster_user_name } = event;
            const login = String(broadcaster_user_name).toLowerCase();
            logger.info(`🔌 ${login} went offline.`);

            // Remove from active streams
            activeStreams.delete(login);

            // Clear the stream context to ensure the poller and keep-alive know the stream is offline
            getContextManager().clearStreamContext(login);
            
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
                // Optionally send a short farewell before parting
                try {
                    const cfg = await getChannelAutoChatConfig(login);
                    if (cfg && cfg.mode !== 'off' && cfg.categories?.greetings) {
                        const channel = `#${login}`;
                        await enqueueMessage(channel, 'Stream just wrapped up — thanks for hanging out! See you next time ✨');
                    }
                } catch (e) {
                    logger.debug({ err: e }, 'Farewell send skipped or failed');
                }
                const ircClient = getIrcClient();
                if (ircClient && ircClient.readyState() === 'OPEN') {
                    const channelToPart = `#${login}`;
                    logger.info(`[EventSub] Attempting to part channel: ${channelToPart}`);
                    await ircClient.part(channelToPart);
                } else {
                    logger.warn(`[EventSub] Received offline event for ${login}, but IRC client is not connected. No action taken.`);
                }
            } catch (error) {
                logger.error({ err: error, channel: login }, 'Error trying to part channel via EventSub offline notification.');
            }
        }

        // --- Celebrations: follows (no username), subscriptions (no username), raids (raider username allowed) ---
        if (subscription.type === 'channel.follow') {
            try {
                const channelName = event?.broadcaster_user_name || event?.to_broadcaster_user_name || null;
                if (!channelName) {
                    logger.warn({ event }, '[EventSub] channel.follow missing broadcaster name');
                    return;
                }
                const allowed = await isChannelAllowed(channelName);
                if (!allowed) return;
                await notifyFollow(channelName.toLowerCase());
            } catch (error) {
                logger.error({ err: error }, '[EventSub] Error handling channel.follow');
            }
        }

        if (subscription.type === 'channel.subscribe') {
            try {
                const channelName = event?.broadcaster_user_name || null;
                if (!channelName) {
                    logger.warn({ event }, '[EventSub] channel.subscribe missing broadcaster name');
                    return;
                }
                const allowed = await isChannelAllowed(channelName);
                if (!allowed) return;
                await notifySubscription(channelName.toLowerCase());
            } catch (error) {
                logger.error({ err: error }, '[EventSub] Error handling channel.subscribe');
            }
        }

        if (subscription.type === 'channel.raid') {
            try {
                const toName = event?.to_broadcaster_user_name || null;
                const fromName = event?.from_broadcaster_user_name || 'a streamer';
                const viewers = event?.viewers || 0;
                if (!toName) {
                    logger.warn({ event }, '[EventSub] channel.raid missing to_broadcaster_user_name');
                    return;
                }
                const allowed = await isChannelAllowed(toName);
                if (!allowed) return;
                await notifyRaid(toName.toLowerCase(), fromName, viewers);
            } catch (error) {
                logger.error({ err: error }, '[EventSub] Error handling channel.raid');
            }
        }

        if (subscription.type === 'channel.ad_break.begin') {
            try {
                const channelName = event?.broadcaster_user_name || event?.broadcaster_user_login || null;
                if (!channelName) {
                    logger.warn({ event }, '[EventSub] channel.ad_break.begin missing broadcaster name');
                    return;
                }
                const allowed = await isChannelAllowed(channelName);
                if (!allowed) return;

                const isAutomatic = event?.is_automatic === true;
                const duration = event?.duration_seconds || event?.duration || 60;

                logger.info({
                    channelName: channelName.toLowerCase(),
                    duration,
                    isAutomatic,
                    requester: event?.requester_user_login
                }, '[EventSub] Ad break started');

                // Only send notification for MANUAL ads (early/unscheduled)
                // Scheduled/automatic ads already get 60s pre-warning from poller
                if (!isAutomatic) {
                    logger.info({ channelName: channelName.toLowerCase() }, '[EventSub] Manual ad detected - sending immediate notification');
                    await notifyAdBreak(channelName.toLowerCase(), event);
                } else {
                    logger.debug({ channelName: channelName.toLowerCase() }, '[EventSub] Automatic ad - notification already sent by poller');
                }
            } catch (error) {
                logger.error({ err: error }, '[EventSub] Error handling channel.ad_break.begin');
            }
        }

        // Handle shared chat session begin
        if (subscription.type === 'channel.shared_chat.begin') {
            try {
                const sessionId = event?.session_id;
                const hostBroadcasterId = event?.host_broadcaster_user_id;
                const participants = event?.participants || [];

                if (!sessionId || !hostBroadcasterId) {
                    logger.warn({ event }, '[EventSub] channel.shared_chat.begin missing required fields');
                    return;
                }

                const channelLogins = participants.map(p => p.broadcaster_user_login);
                logger.info({
                    sessionId,
                    hostBroadcasterId,
                    participantCount: participants.length,
                    channels: channelLogins
                }, `[EventSub] Shared chat session started: ${channelLogins.join(', ')}`);

                sharedChatManager.addSession(sessionId, hostBroadcasterId, participants);
            } catch (error) {
                logger.error({ err: error }, '[EventSub] Error handling channel.shared_chat.begin');
            }
        }

        // Handle shared chat session update
        if (subscription.type === 'channel.shared_chat.update') {
            try {
                const sessionId = event?.session_id;
                const participants = event?.participants || [];

                if (!sessionId) {
                    logger.warn({ event }, '[EventSub] channel.shared_chat.update missing session_id');
                    return;
                }

                const channelLogins = participants.map(p => p.broadcaster_user_login);
                logger.info({
                    sessionId,
                    participantCount: participants.length,
                    channels: channelLogins
                }, `[EventSub] Shared chat session updated: ${channelLogins.join(', ')}`);

                sharedChatManager.updateSession(sessionId, participants);
            } catch (error) {
                logger.error({ err: error }, '[EventSub] Error handling channel.shared_chat.update');
            }
        }

        // Handle shared chat session end
        if (subscription.type === 'channel.shared_chat.end') {
            try {
                const sessionId = event?.session_id;

                if (!sessionId) {
                    logger.warn({ event }, '[EventSub] channel.shared_chat.end missing session_id');
                    return;
                }

                logger.info({ sessionId }, '[EventSub] Shared chat session ended');
                
                // Clean up Gemini chat sessions for this shared session
                const { clearChatSession } = await import('../llm/geminiClient.js');
                clearChatSession(sessionId);
                
                sharedChatManager.removeSession(sessionId);
            } catch (error) {
                logger.error({ err: error }, '[EventSub] Error handling channel.shared_chat.end');
            }
        }
    }
}

/**
 * Marks lazy connect as initialized (called from bot.js when starting pollers in LAZY_CONNECT mode)
 */
export function markLazyConnectInitialized() {
    lazyConnectInitialized = true;
    logger.debug('Lazy connect marked as initialized');
}
