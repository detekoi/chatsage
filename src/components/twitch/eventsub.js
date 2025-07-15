import crypto from 'crypto';
import axios from 'axios';
import config from '../../config/index.js';
import logger from '../../lib/logger.js';
import { getIrcClient, connectIrcClient } from './ircClient.js';
import { scheduleNextKeepAlivePing, deleteTask } from '../../lib/taskHelpers.js';
import { getContextManager } from '../context/contextManager.js';

// Track active streams and keep-alive tasks
const activeStreams = new Set();
let keepAliveTaskName = null;

/**
 * Handles the keep-alive ping from Cloud Tasks
 * This is called by the /keep-alive endpoint
 */
export async function handleKeepAlivePing() {
    const contextManager = getContextManager();
    // Create a copy to iterate over, allowing safe modification of the original set
    const streamsToCheck = [...activeStreams]; 
    let trulyActiveCount = 0;

    for (const channelName of streamsToCheck) {
        const context = contextManager.getContextForLLM(channelName, 'system', 'keep-alive-check');
        // A stream is considered active if the poller has recently set its game context.
        if (context && context.streamGame && context.streamGame !== 'N/A') {
            trulyActiveCount++;
        } else {
            // If context shows offline, prune it from the active set
            logger.warn(`[EventSub] Pruning stale stream '${channelName}' from active list during keep-alive check. Poller likely marked it as offline.`);
            activeStreams.delete(channelName);
        }
    }

    if (trulyActiveCount > 0) {
        logger.debug(`Keep-alive ping processed. ${trulyActiveCount} stream(s) confirmed active. Scheduling next ping.`);
        try {
            keepAliveTaskName = await scheduleNextKeepAlivePing(240); // 4 minutes
        } catch (error) {
            logger.error({ err: error }, 'Failed to schedule next keep-alive ping');
        }
    } else {
        logger.info('Keep-alive ping received, and no streams are confirmed active by the poller. Allowing instance to scale down.');
        if (keepAliveTaskName) {
            try {
                await deleteTask(keepAliveTaskName);
                keepAliveTaskName = null;
            } catch (error) {
                logger.error({ err: error }, 'Failed to delete final keep-alive task.');
            }
        }
    }
}

function verifySignature(req, rawBody) {
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
            const { broadcaster_user_id, broadcaster_user_name } = event;
            logger.info(`📡 ${broadcaster_user_name} just went live — ensuring bot is active...`);

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

            if (process.env.LAZY_CONNECT) {
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
            const { broadcaster_user_id, broadcaster_user_name } = event;
            logger.info(`🔌 ${broadcaster_user_name} went offline.`);

            // Remove from active streams
            activeStreams.delete(broadcaster_user_name);

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