import crypto from 'crypto';
import logger from '../../lib/logger.js';
import { connectIrcClient, getIrcClient, createIrcClient } from './ircClient.js';
import { getActiveManagedChannels } from './channelManager.js';
import config from '../../config/index.js';

const secret = process.env.TWITCH_EVENTSUB_SECRET;
let ircReady = false;

/**
 * Compute Twitch-style HMAC and compare with header.
 * Spec: sig = "sha256=" + HMAC_SHA256(secret, messageId + timestamp + rawBody)
 */
function verifySignature(req, raw) {
    if (!secret) {
        logger.error('TWITCH_EVENTSUB_SECRET not configured');
        return false;
    }

    const id = req.headers['twitch-eventsub-message-id'];
    const ts = req.headers['twitch-eventsub-message-timestamp'];
    const sig = req.headers['twitch-eventsub-message-signature'];

    if (!id || !ts || !sig) {
        logger.warn('Missing required EventSub headers');
        return false;
    }

    const hmac = crypto
        .createHmac('sha256', secret)
        .update(id + ts + raw)
        .digest('hex');
    const expected = `sha256=${hmac}`;

    try {
        return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch (error) {
        logger.error({ err: error }, 'Error verifying EventSub signature');
        return false;
    }
}

async function ensureIrc() {
    if (!ircReady) {
        logger.info('EventSub triggered - initializing IRC connection...');
        try {
            // Check if IRC client exists, if not create it first (for lazy connect mode)
            let client;
            try {
                client = getIrcClient();
            } catch (error) {
                logger.info('IRC client not created yet, creating it now...');
                client = await createIrcClient(config.twitch);
            }
            
            // Now connect if not already connected
            if (client.readyState() !== 'OPEN') {
                await connectIrcClient();
            }
            
            ircReady = true;
            logger.info('IRC connection established from EventSub trigger');
        } catch (error) {
            logger.error({ err: error }, 'Failed to establish IRC connection from EventSub');
            throw error;
        }
    }
}

async function joinChannel(channelName) {
    try {
        const client = getIrcClient();
        const channelWithHash = channelName.startsWith('#') ? channelName : `#${channelName}`;
        
        // Check if already in channel
        const currentChannels = client.getChannels();
        if (currentChannels.includes(channelWithHash)) {
            logger.debug(`Already in channel ${channelWithHash}`);
            return;
        }

        await client.join(channelWithHash);
        logger.info(`Joined channel ${channelWithHash} via EventSub trigger`);
    } catch (error) {
        logger.error({ err: error, channel: channelName }, 'Failed to join channel via EventSub');
    }
}

export async function eventSubHandler(req, res, rawBody) {
    if (!verifySignature(req, rawBody)) {
        logger.warn('⚠️ Bad EventSub signature');
        res.writeHead(403).end();
        return;
    }

    const msgType = req.headers['twitch-eventsub-message-type'];
    const payload = JSON.parse(rawBody.toString());

    logger.debug({ msgType, payload }, 'EventSub message received');

    // 1. Initial webhook handshake
    if (msgType === 'webhook_callback_verification') {
        logger.info('EventSub webhook verification received');
        res.writeHead(200, { 'Content-Type': 'text/plain' })
           .end(payload.challenge);
        return;
    }

    // 2. Handle revocations
    if (msgType === 'revocation') {
        logger.warn({ payload }, 'EventSub subscription revoked');
        res.writeHead(200).end();
        return;
    }

    // 3. Stream went live — spin up the bot
    if (msgType === 'notification' && payload.subscription.type === 'stream.online') {
        const login = payload.event.broadcaster_user_login;
        logger.info(`📡 ${login} just went live — ensuring bot is active...`);

        try {
            await ensureIrc();
            await joinChannel(login);
        } catch (error) {
            logger.error({ err: error, channel: login }, 'Error handling stream.online event');
        }
    }

    // 4. Always ACK within a couple seconds so Twitch doesn't retry
    res.writeHead(200).end();
}