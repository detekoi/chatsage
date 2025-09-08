// src/components/twitch/twitchSubs.js

import { getHelixClient, getUsersByLogin } from './helixClient.js';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';

// --- HELPER FUNCTIONS ---

async function makeHelixRequest(method, endpoint, body = null) {
    try {
        const helixClient = getHelixClient();
        const response = await helixClient({
            method: method,
            url: endpoint,
            data: body
        });
        return { success: true, data: response.data };
    } catch (error) {
        logger.error({ 
            err: error.response ? error.response.data : error.message, 
            method, 
            endpoint 
        }, 'Error making Helix request');
        return { success: false, error: error.message };
    }
}

// --- EXPORTED FUNCTIONS ---

export async function subscribeStreamOnline(broadcasterUserId) {
    const { publicUrl, eventSubSecret } = config.twitch;
    if (!publicUrl || !eventSubSecret) {
        logger.error('Missing PUBLIC_URL or TWITCH_EVENTSUB_SECRET in config');
        return { success: false, error: 'Missing configuration' };
    }
    
    const body = {
        type: 'stream.online',
        version: '1',
        condition: { broadcaster_user_id: broadcasterUserId },
        transport: { method: 'webhook', callback: `${publicUrl}/twitch/event`, secret: eventSubSecret }
    };
    
    const result = await makeHelixRequest('post', '/eventsub/subscriptions', body);
    if (result.success) {
        logger.info({ subscriptionId: result.data.data[0].id, broadcasterUserId, status: result.data.data[0].status }, 'EventSub stream.online subscription created successfully');
    }
    return result;
}

export async function subscribeStreamOffline(broadcasterUserId) {
    const { publicUrl, eventSubSecret } = config.twitch;
    if (!publicUrl || !eventSubSecret) {
        logger.error('Missing PUBLIC_URL or TWITCH_EVENTSUB_SECRET in config');
        return { success: false, error: 'Missing configuration' };
    }

    const body = {
        type: 'stream.offline',
        version: '1',
        condition: { broadcaster_user_id: broadcasterUserId },
        transport: { method: 'webhook', callback: `${publicUrl}/twitch/event`, secret: eventSubSecret }
    };
    
    const result = await makeHelixRequest('post', '/eventsub/subscriptions', body);
    if (result.success) {
        logger.info({ broadcasterUserId }, 'Successfully subscribed to stream.offline');
    }
    return result;
}

export async function getEventSubSubscriptions() {
    return await makeHelixRequest('get', '/eventsub/subscriptions');
}

export async function deleteEventSubSubscription(subscriptionId) {
    const result = await makeHelixRequest('delete', `/eventsub/subscriptions?id=${subscriptionId}`);
    if (result.success) {
        logger.info({ subscriptionId }, 'EventSub subscription deleted successfully');
    }
    return result;
}

export async function deleteAllEventSubSubscriptions() {
    const result = await getEventSubSubscriptions();
    if (!result.success || !result.data || !result.data.data) {
        logger.error('Could not fetch subscriptions to delete.');
        return;
    }
    
    const subscriptions = result.data.data;
    if (subscriptions.length === 0) {
        console.log('No subscriptions to delete.');
        return;
    }
    
    for (const sub of subscriptions) {
        await deleteEventSubSubscription(sub.id);
    }
    logger.info(`Deleted ${subscriptions.length} subscriptions.`);
}

// Optional helpers to subscribe to celebration-related events
export async function subscribeChannelFollow(broadcasterUserId) {
    const { publicUrl, eventSubSecret } = config.twitch;
    if (!publicUrl || !eventSubSecret) {
        logger.error('Missing PUBLIC_URL or TWITCH_EVENTSUB_SECRET in config');
        return { success: false, error: 'Missing configuration' };
    }
    const body = {
        type: 'channel.follow',
        version: '2',
        condition: { broadcaster_user_id: broadcasterUserId, moderator_user_id: broadcasterUserId },
        transport: { method: 'webhook', callback: `${publicUrl}/twitch/event`, secret: eventSubSecret }
    };
    // Version 2 requires moderator_user_id for the broadcaster or a moderator of the channel
    return await makeHelixRequest('post', '/eventsub/subscriptions', body);
}

export async function subscribeChannelSubscribe(broadcasterUserId) {
    const { publicUrl, eventSubSecret } = config.twitch;
    if (!publicUrl || !eventSubSecret) {
        logger.error('Missing PUBLIC_URL or TWITCH_EVENTSUB_SECRET in config');
        return { success: false, error: 'Missing configuration' };
    }
    const body = {
        type: 'channel.subscribe',
        version: '1',
        condition: { broadcaster_user_id: broadcasterUserId },
        transport: { method: 'webhook', callback: `${publicUrl}/twitch/event`, secret: eventSubSecret }
    };
    return await makeHelixRequest('post', '/eventsub/subscriptions', body);
}

export async function subscribeChannelRaid(broadcasterUserId) {
    const { publicUrl, eventSubSecret } = config.twitch;
    if (!publicUrl || !eventSubSecret) {
        logger.error('Missing PUBLIC_URL or TWITCH_EVENTSUB_SECRET in config');
        return { success: false, error: 'Missing configuration' };
    }
    const body = {
        type: 'channel.raid',
        version: '1',
        condition: { to_broadcaster_user_id: broadcasterUserId },
        transport: { method: 'webhook', callback: `${publicUrl}/twitch/event`, secret: eventSubSecret }
    };
    return await makeHelixRequest('post', '/eventsub/subscriptions', body);
}

export async function subscribeAllManagedChannels() {
    try {
        const { getActiveManagedChannels } = await import('./channelManager.js');
        const activeChannels = await getActiveManagedChannels();
        const results = { successful: [], failed: [], total: activeChannels.length };

        for (const channelName of activeChannels) {
            try {
                const userResponseArray = await getUsersByLogin([channelName]);
                if (!userResponseArray || userResponseArray.length === 0) {
                    logger.warn({ channelName }, 'Could not find user ID for channel');
                    results.failed.push({ channel: channelName, error: 'User not found' });
                    continue;
                }
                const userResponse = userResponseArray[0];

                if (!userResponse || !userResponse.id) {
                     logger.warn({ channelName, userResponse }, 'User object found but missing ID.');
                     results.failed.push({ channel: channelName, error: 'User object missing ID' });
                     continue;
                }

                const onlineSubResult = await subscribeStreamOnline(userResponse.id);
                const offlineSubResult = await subscribeStreamOffline(userResponse.id);

                if (onlineSubResult.success && offlineSubResult.success) {
                    results.successful.push({ channel: channelName, userId: userResponse.id });
                } else {
                    results.failed.push({ channel: channelName, error: 'Failed to create one or more subscriptions' });
                }
            } catch (error) {
                logger.error({ err: error, channelName }, 'Error subscribing channel to EventSub');
                results.failed.push({ channel: channelName, error: error.message });
            }
        }
        logger.info({ successful: results.successful.length, failed: results.failed.length, total: results.total }, 'EventSub subscription batch completed');
        return results;
    } catch (error) {
        logger.error({ err: error }, 'Error in subscribeAllManagedChannels');
        return { successful: [], failed: [], total: 0, error: error.message };
    }
}