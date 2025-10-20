// src/components/twitch/twitchSubs.js

import { getHelixClient, getUsersByLogin } from './helixClient.js';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';

// --- CACHE FOR EVENTSUB SUBSCRIPTIONS ---
let eventSubSubscriptionsCache = null;
let eventSubSubscriptionsCacheTimestamp = 0;
const EVENTSUB_CACHE_TTL_MS = 60000; // 60 seconds

function clearEventSubSubscriptionsCache() {
    eventSubSubscriptionsCache = null;
    eventSubSubscriptionsCacheTimestamp = 0;
    logger.debug('EventSub subscriptions cache cleared');
}

// --- HELPER FUNCTIONS ---

async function makeHelixRequest(method, endpoint, body = null, userAccessToken = null, context = null) {
    try {
        // If a userAccessToken is provided, bypass the shared axios instance to specify headers
        if (userAccessToken) {
            const helixClient = (await import('axios')).default.create({ baseURL: 'https://api.twitch.tv/helix', timeout: 15000 });
            const axiosConfig = {
                method: method,
                url: endpoint,
                data: body,
                headers: {
                    'Authorization': `Bearer ${userAccessToken}`,
                    'Client-ID': config.twitch.clientId,
                    'Content-Type': 'application/json'
                }
            };
            if (context) {
                axiosConfig.meta = { context };
            }
            const response = await helixClient(axiosConfig);
            return { success: true, data: response.data };
        }
        const helixClient = getHelixClient();
        const axiosConfig = { method, url: endpoint, data: body };
        if (context) {
            axiosConfig.meta = { context };
        }
        const response = await helixClient(axiosConfig);
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
        clearEventSubSubscriptionsCache(); // Clear cache after creating subscription
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
        clearEventSubSubscriptionsCache(); // Clear cache after creating subscription
    }
    return result;
}

export async function getEventSubSubscriptions(context = 'Fetch EventSub subscriptions', useCache = true) {
    // Check cache if enabled
    if (useCache && eventSubSubscriptionsCache && (Date.now() - eventSubSubscriptionsCacheTimestamp < EVENTSUB_CACHE_TTL_MS)) {
        logger.debug('Using cached EventSub subscriptions');
        return eventSubSubscriptionsCache;
    }

    // Fetch from API
    const result = await makeHelixRequest('get', '/eventsub/subscriptions', null, null, context);

    // Cache successful results
    if (result.success) {
        eventSubSubscriptionsCache = result;
        eventSubSubscriptionsCacheTimestamp = Date.now();
        logger.debug('EventSub subscriptions cached');
    }

    return result;
}

export async function deleteEventSubSubscription(subscriptionId) {
    const result = await makeHelixRequest('delete', `/eventsub/subscriptions?id=${subscriptionId}`);
    if (result.success) {
        logger.info({ subscriptionId }, 'EventSub subscription deleted successfully');
        clearEventSubSubscriptionsCache(); // Clear cache after deleting subscription
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

export async function subscribeChannelAdBreakBegin(broadcasterUserId, userAccessToken) {
    const { publicUrl, eventSubSecret } = config.twitch;
    if (!publicUrl || !eventSubSecret) {
        logger.error('Missing PUBLIC_URL or TWITCH_EVENTSUB_SECRET in config');
        return { success: false, error: 'Missing configuration' };
    }
    const body = {
        type: 'channel.ad_break.begin',
        version: '1',
        condition: { broadcaster_user_id: broadcasterUserId },
        transport: { method: 'webhook', callback: `${publicUrl}/twitch/event`, secret: eventSubSecret }
    };
    // Must use a broadcaster user token with channel:read:ads
    const result = await makeHelixRequest('post', '/eventsub/subscriptions', body, userAccessToken || undefined);
    if (result.success) {
        logger.info({ broadcasterUserId }, 'Successfully subscribed to channel.ad_break.begin');
        clearEventSubSubscriptionsCache(); // Clear cache after creating subscription
    }
    return result;
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

export async function ensureAdBreakSubscriptionForBroadcaster(broadcasterUserId, enabled, userAccessToken) {
    try {
        const subsRes = await getEventSubSubscriptions();
        const subs = subsRes?.data?.data || [];
        const existing = subs.filter(s => s.type === 'channel.ad_break.begin' && (s.condition?.broadcaster_user_id === String(broadcasterUserId)));

        if (enabled) {
            if (existing.length > 0) {
                logger.info({ broadcasterUserId }, 'Ad break subscription already exists');
                return { success: true, already: true };
            }
            return await subscribeChannelAdBreakBegin(broadcasterUserId, userAccessToken);
        } else {
            for (const sub of existing) {
                try { await deleteEventSubSubscription(sub.id); } catch (e) { /* ignore */ }
            }
            clearEventSubSubscriptionsCache(); // Clear cache after deleting subscriptions
            return { success: true, deleted: existing.length };
        }
    } catch (e) {
        logger.error({ err: e, broadcasterUserId, enabled }, 'ensureAdBreakSubscriptionForBroadcaster failed');
        return { success: false, error: e.message };
    }
}