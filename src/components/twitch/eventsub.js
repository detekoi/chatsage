// src/components/twitch/eventsub.js
import crypto from 'crypto';
import axios from 'axios'; // Use axios instead of node-fetch
import config from '../../config/index.js';
import { logger } from '../../lib/logger.js';
import { getIrcClient } from './ircClient.js';
import { getChannelManager } from './channelManager.js';

const activePings = new Map();

/**
 * Pings the bot's own public URL to prevent Cloud Run from scaling to zero during a live stream.
 */
async function selfPing() {
    if (!config.twitch.publicUrl) return;
    try {
        const response = await axios.get(config.twitch.publicUrl, { timeout: 5000 });
        if (response.status === 200) {
            logger.info('Self-ping successful, keeping instance alive.');
        } else {
            logger.warn({ status: response.status }, 'Self-ping failed.');
        }
    } catch (error) {
        logger.error({ err: error.message }, 'Error during self-ping.');
    }
}


/**
 * Verifies the HMAC signature of the Twitch webhook.
 * @param {object} req - The HTTP request object.
 * @param {Buffer} rawBody - The raw request body.
 * @returns {boolean} True if the signature is valid, false otherwise.
 */
function verifySignature(req, rawBody) {
    const secret = config.twitch.eventSubSecret;
    const messageId = req.headers['twitch-eventsub-message-id'];
    const timestamp = req.headers['twitch-eventsub-message-timestamp'];
    const signature = req.headers['twitch-eventsub-message-signature'];
    
    if (!secret || !messageId || !timestamp || !signature) {
        return false;
    }

    const hmacMessage = messageId + timestamp + rawBody;
    const hmac = 'sha256=' + crypto.createHmac('sha256', secret).update(hmacMessage).digest('hex');
    
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature));
}

/**
 * Handles incoming EventSub webhook notifications from Twitch.
 * @param {object} req - The HTTP request object.
 * @param {object} res - The HTTP response object.
 * @param {Buffer} rawBody - The raw request body.
 */
export async function eventSubHandler(req, res, rawBody) {
    if (!verifySignature(req, rawBody)) {
        logger.warn('⚠️ Bad EventSub signature');
        res.writeHead(403).end();
        return;
    }

    const notification = JSON.parse(rawBody);
    const messageType = req.headers['twitch-eventsub-message-type'];

    // Respond immediately to Twitch to acknowledge receipt
    if (messageType !== 'webhook_callback_verification') {
        res.writeHead(200).end();
    }

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
                // Ping every 10 minutes (600,000 milliseconds)
                const intervalId = setInterval(selfPing, 10 * 60 * 1000); 
                activePings.set(broadcaster_user_id, intervalId);
            }

            if (config.twitch.lazyConnect) {
                const ircClient = getIrcClient();
                await ircClient.connectToChannel(broadcaster_user_name);
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