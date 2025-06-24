import crypto from 'crypto';
import axios from 'axios';
import config from '../../config/index.js';
import logger from '../../lib/logger.js'; // <-- This was the line causing the crash
import { getIrcClient, connectIrcClient } from './ircClient.js';
import { getChannelManager } from './channelManager.js';

const activePings = new Map();

async function selfPing() {
    if (!config.twitch.publicUrl) return;
    try {
        await axios.get(config.twitch.publicUrl, { timeout: 5000 });
        logger.info('Self-ping successful, keeping instance alive.');
    } catch (error) {
        logger.error({ err: error.message }, 'Error during self-ping.');
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

            if (!activePings.has(broadcaster_user_id)) {
                logger.info({ channel: broadcaster_user_name }, 'Starting self-ping to keep instance alive.');
                const intervalId = setInterval(selfPing, 10 * 60 * 1000); 
                activePings.set(broadcaster_user_id, intervalId);
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

            if (activePings.has(broadcaster_user_id)) {
                logger.info({ channel: broadcaster_user_name }, 'Stopping self-ping for offline channel.');
                clearInterval(activePings.get(broadcaster_user_id));
                activePings.delete(broadcaster_user_id);
            }
            
            const channelManager = getChannelManager();
            if (channelManager) {
                await channelManager.partChannel(broadcaster_user_name);
            }
        }
    }
}