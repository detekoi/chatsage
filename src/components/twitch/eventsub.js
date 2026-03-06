import crypto from 'crypto';
import config from '../../config/index.js';
import logger from '../../lib/logger.js';
import { isChannelAllowed } from './channelManager.js';
import { getContextManager } from '../context/contextManager.js';
import { getChannelAutoChatConfig } from '../context/autoChatStorage.js';
import { enqueueMessage } from '../../lib/ircSender.js';
import { notifyStreamOnline, notifyFollow, notifySubscription, notifyRaid, notifyAdBreak } from '../autoChat/autoChatManager.js';
import * as sharedChatManager from './sharedChatManager.js';
import LifecycleManager from '../../services/LifecycleManager.js';
import { convertEventSubToTags } from './eventSubToTags.js';
import { handleChatMessage } from '../../handlers/chatMessageHandler.js';
import { handleCheckinRedemption } from '../../handlers/checkinHandler.js';

// --- Initialization Gate ---
// During cold start, EventSub webhooks can arrive before components are initialized.
// This gate ensures we wait for initialization before processing notifications.
let _initResolve;
let _initPromise = new Promise(resolve => { _initResolve = resolve; });
let _isInitialized = false;

/**
 * Signal that all components are initialized and EventSub can process notifications.
 * Called from bot.js after initializeAllComponents() completes.
 */
export function markEventSubReady() {
    if (!_isInitialized) {
        _isInitialized = true;
        _initResolve();
        logger.info('[EventSub] Components initialized — ready to process notifications');
    }
}

/**
 * Wait for initialization with a timeout.
 * Returns true if initialized, false if timed out.
 */
async function waitForInit(timeoutMs = 15000) {
    if (_isInitialized) return true;
    const timeout = new Promise(resolve => setTimeout(() => resolve(false), timeoutMs));
    const ready = _initPromise.then(() => true);
    return Promise.race([ready, timeout]);
}

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
 *
 * Note: Keep-alive is now managed by KeepAliveActor, so this is a no-op.
 */
export async function cleanupKeepAliveTasks() {
    logger.debug('Cleaning up any orphaned keep-alive tasks...');
    // Keep-alive is now managed by KeepAliveActor in LifecycleManager
    // No action needed here
}

/**
 * Legacy endpoint - no longer used with in-process keep-alive
 * Kept for backwards compatibility but does nothing
 * @deprecated Use in-process KeepAliveActor instead
 */
export async function handleKeepAlivePing() {
    logger.debug('Legacy /keep-alive endpoint called - now using in-process keep-alive');
}

/**
 * Manually clear phantom EventSub entries (useful for debugging/cleanup)
 * @param {string[]} streamNames - Optional array of specific streams to remove, or empty to clear all
 */
export async function clearPhantomEventSubEntries(streamNames = []) {
    const lifecycle = LifecycleManager.get();
    const activeStreams = lifecycle.getActiveStreams();

    if (streamNames.length === 0) {
        logger.info(`Clearing all phantom EventSub entries. Previously tracking: ${activeStreams.join(', ')}`);
        for (const stream of activeStreams) {
            await lifecycle.onStreamStatusChange(stream, false);
        }
    } else {
        for (const streamName of streamNames) {
            await lifecycle.onStreamStatusChange(streamName, false);
            logger.info(`Removed phantom EventSub entry for: ${streamName}`);
        }
    }
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

    if (!secret || !messageId || !timestamp || !signature) {
        logger.warn('A required header or secret for signature verification is missing.');
        return false;
    }

    const hmacMessage = messageId + timestamp + rawBody;
    const hmac = 'sha256=' + crypto.createHmac('sha256', secret).update(hmacMessage).digest('hex');

    const isSignatureValid = crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature));

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

        // Wait for components to be initialized during cold start
        const ready = await waitForInit();
        if (!ready) {
            logger.error('[EventSub] Timed out waiting for initialization — dropping notification');
            return;
        }

        const { subscription, event } = notification;
        const lifecycle = LifecycleManager.get();

        if (subscription.type === 'stream.online') {
            try {
                const { broadcaster_user_name } = event;
                const login = String(broadcaster_user_name).toLowerCase();
                logger.info(`📡 ${login} just went live — notifying LifecycleManager...`);

                // Enforce allow-list (prefer broadcaster ID for immutability)
                const broadcasterId = event?.broadcaster_user_id;
                const allowed = await isChannelAllowed(broadcasterId || login);
                if (!allowed) {
                    logger.warn(`[EventSub] ${broadcaster_user_name} is not on the allow-list or not active. Ignoring stream.online event.`);
                    return;
                }

                // Notify Lifecycle Manager (which will manage keep-alive via KeepAliveActor)
                await lifecycle.onStreamStatusChange(login, true);

                // Inform AutoChatManager so it can greet once
                try { notifyStreamOnline(login); } catch (e) { /* ignore */ }
            } catch (error) {
                logger.error({ err: error, event }, '[EventSub] Error handling stream.online');
            }
        }

        if (subscription.type === 'stream.offline') {
            try {
                const { broadcaster_user_name } = event;
                const login = String(broadcaster_user_name).toLowerCase();
                logger.info(`🔌 ${login} went offline.`);

                // Notify Lifecycle Manager (which will manage keep-alive via KeepAliveActor)
                await lifecycle.onStreamStatusChange(login, false);

                // Clear the stream context
                getContextManager().clearStreamContext(login);

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
                } catch (error) {
                    logger.error({ err: error, channel: login }, 'Error trying to send farewell via EventSub offline notification.');
                }
            } catch (error) {
                logger.error({ err: error, event }, '[EventSub] Error handling stream.offline');
            }
        }

        // --- Chat Message Handler (EventSub replacing IRC) ---
        if (subscription.type === 'channel.chat.message') {
            try {
                const channelLogin = event?.broadcaster_user_login?.toLowerCase();
                if (!channelLogin) {
                    logger.warn({ event }, '[EventSub] channel.chat.message missing broadcaster_user_login');
                    return;
                }

                // Enforce allow-list
                const broadcasterId = event?.broadcaster_user_id;
                const allowed = await isChannelAllowed(broadcasterId || channelLogin);
                if (!allowed) {
                    logger.debug({ channelLogin }, '[EventSub] Chat message from non-allowed channel, ignoring');
                    return;
                }

                // Extract message text from EventSub format
                // EventSub message.text contains the full message text
                const messageText = event?.message?.text || '';

                // Convert EventSub event to IRC-style tags
                const tags = convertEventSubToTags(event);

                // Format channel with # prefix as expected by the handler
                const channel = `#${channelLogin}`;

                logger.debug({
                    channel: channelLogin,
                    user: tags.username,
                    message: messageText.substring(0, 50)
                }, '[EventSub] Processing channel.chat.message');

                // Dispatch to the shared chat message handler
                await handleChatMessage(channel, tags, messageText);
            } catch (error) {
                logger.error({ err: error, event }, '[EventSub] Error handling channel.chat.message');
            }
        }

        // --- Channel Points Redemption Handler (Daily Check-In) ---
        if (subscription.type === 'channel.channel_points_custom_reward_redemption.add') {
            try {
                const channelLogin = event?.broadcaster_user_login?.toLowerCase();
                const broadcasterId = event?.broadcaster_user_id;
                if (!channelLogin || !broadcasterId) {
                    logger.warn({ event }, '[EventSub] channel_points redemption missing required fields');
                    return;
                }

                const allowed = await isChannelAllowed(broadcasterId || channelLogin);
                if (!allowed) {
                    logger.debug({ channelLogin }, '[EventSub] Channel Points event for non-allowed channel');
                    return;
                }

                handleCheckinRedemption(event).catch(error => {
                    logger.error({ err: error, event }, '[EventSub] Error handling Channel Points redemption');
                });
            } catch (error) {
                logger.error({ err: error, event }, '[EventSub] Error setting up Channel Points redemption handler');
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
                const broadcasterId = event?.broadcaster_user_id;
                const allowed = await isChannelAllowed(broadcasterId || channelName);
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
                const broadcasterId = event?.broadcaster_user_id;
                const allowed = await isChannelAllowed(broadcasterId || channelName);
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
                const toBroadcasterId = event?.to_broadcaster_user_id;
                const allowed = await isChannelAllowed(toBroadcasterId || toName);
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
                const broadcasterId = event?.broadcaster_user_id;
                const allowed = await isChannelAllowed(broadcasterId || channelName);
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
