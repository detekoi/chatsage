// src/components/twitch/twitchSubs.js

import { getHelixClient, getUsersByLogin } from './helixClient.js';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';

// --- CACHE FOR EVENTSUB SUBSCRIPTIONS ---
let eventSubSubscriptionsCache = null;
let eventSubSubscriptionsCacheTimestamp = 0;
let eventSubSubscriptionsInFlightPromise = null; // Track in-flight requests
const EVENTSUB_CACHE_TTL_MS = 60000; // 60 seconds

function clearEventSubSubscriptionsCache() {
    eventSubSubscriptionsCache = null;
    eventSubSubscriptionsCacheTimestamp = 0;
    eventSubSubscriptionsInFlightPromise = null;
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
        // 409 Conflict = subscription already exists, treat as success
        if (error.response?.status === 409 && endpoint === '/eventsub/subscriptions') {
            logger.debug({ method, endpoint }, 'EventSub subscription already exists (409) - treating as success');
            return { success: true, alreadyExists: true };
        }
        logger.error({
            err: error.response ? error.response.data : error.message,
            method,
            endpoint
        }, 'Error making Helix request');
        return { success: false, error: error.message };
    }
}

// --- EXPORTED FUNCTIONS ---

export function getSubKey(type, condition) {
    const parts = Object.entries(condition || {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`);
    return `${type}|${parts.join('|')}`;
}

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
        if (result.alreadyExists) {
            logger.info({ broadcasterUserId }, 'EventSub stream.online subscription already exists');
        } else {
            logger.info({ subscriptionId: result.data.data[0].id, broadcasterUserId, status: result.data.data[0].status }, 'EventSub stream.online subscription created successfully');
        }
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
        logger.debug({ context }, 'Using cached EventSub subscriptions');
        return eventSubSubscriptionsCache;
    }

    // If there's already a request in flight, wait for it instead of making a new one
    if (useCache && eventSubSubscriptionsInFlightPromise) {
        logger.debug({ context }, 'Waiting for in-flight EventSub subscriptions request to complete');
        return await eventSubSubscriptionsInFlightPromise;
    }

    // Fetch from API
    logger.debug({ context }, 'Fetching EventSub subscriptions from API');
    
    const fetchPromise = (async () => {
        let allSubs = [];
        let cursor = null;
        let totalCost = 0;
        let maxTotalCost = 0;
        let total = 0;

        do {
            const endpoint = cursor ? `/eventsub/subscriptions?after=${encodeURIComponent(cursor)}` : '/eventsub/subscriptions';
            const result = await makeHelixRequest('get', endpoint, null, null, context);
            if (!result.success) {
                // Return immediately without caching to avoid poisoning cache with partial results
                return { success: false, error: result.error || 'Failed to fetch EventSub subscriptions' };
            }
            
            allSubs.push(...(result.data?.data || []));
            totalCost = result.data?.total_cost || totalCost;
            maxTotalCost = result.data?.max_total_cost || maxTotalCost;
            total = result.data?.total || total;
            cursor = result.data?.pagination?.cursor || null;
        } while (cursor);
        
        const finalResult = {
            success: true,
            data: {
                data: allSubs,
                total_cost: totalCost,
                max_total_cost: maxTotalCost,
                total: total
            }
        };

        eventSubSubscriptionsCache = finalResult;
        eventSubSubscriptionsCacheTimestamp = Date.now();
        logger.debug({ context, subscriptionCount: allSubs.length }, 'EventSub subscriptions fetched and cached');
        
        return finalResult;
    })();

    eventSubSubscriptionsInFlightPromise = fetchPromise;
    try {
        const result = await fetchPromise;
        eventSubSubscriptionsInFlightPromise = null;
        return result;
    } catch (error) {
        eventSubSubscriptionsInFlightPromise = null;
        throw error;
    }
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

export async function subscribeChannelSubscriptionGift(broadcasterUserId) {
    const { publicUrl, eventSubSecret } = config.twitch;
    if (!publicUrl || !eventSubSecret) {
        logger.error('Missing PUBLIC_URL or TWITCH_EVENTSUB_SECRET in config');
        return { success: false, error: 'Missing configuration' };
    }
    const body = {
        type: 'channel.subscription.gift',
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

export async function subscribeChannelChatMessage(broadcasterUserId) {
    const { publicUrl, eventSubSecret } = config.twitch;
    if (!publicUrl || !eventSubSecret) {
        logger.error('Missing PUBLIC_URL or TWITCH_EVENTSUB_SECRET in config');
        return { success: false, error: 'Missing configuration' };
    }

    // Get the bot's user ID (required for channel.chat.message condition)
    const { getBotUserId } = await import('./chatClient.js');
    const botUserId = await getBotUserId();
    if (!botUserId) {
        logger.error('Could not determine bot user ID for channel.chat.message subscription');
        return { success: false, error: 'Could not determine bot user ID' };
    }

    const body = {
        type: 'channel.chat.message',
        version: '1',
        condition: {
            broadcaster_user_id: broadcasterUserId,
            user_id: botUserId // The bot's user ID (must have granted user:read:chat + user:bot scopes)
        },
        transport: {
            method: 'webhook',
            callback: `${publicUrl}/twitch/event`,
            secret: eventSubSecret
        }
    };

    const result = await makeHelixRequest('post', '/eventsub/subscriptions', body);
    if (result.success) {
        logger.info({ broadcasterUserId, botUserId, type: 'channel.chat.message' }, 'Successfully subscribed to channel.chat.message');
        clearEventSubSubscriptionsCache();
    } else {
        const is403 = result.error && result.error.includes('403');
        const logLevel = is403 ? 'warn' : 'error';
        const msg = is403
            ? 'channel.chat.message subscription rejected (broadcaster has not authorized bot or added as mod)'
            : 'CRITICAL: Failed to subscribe to channel.chat.message - channel will not receive chat messages!';
            
        logger[logLevel]({
            broadcasterUserId,
            error: result.error,
            type: 'channel.chat.message'
        }, msg);
    }
    return result;
}

// --- Channel Points EventSub Subscriptions ---

export async function subscribeChannelPointsRedemptionAdd(broadcasterUserId) {
    const { publicUrl, eventSubSecret } = config.twitch;
    if (!publicUrl || !eventSubSecret) {
        logger.error('Missing PUBLIC_URL or TWITCH_EVENTSUB_SECRET in config');
        return { success: false, error: 'Missing configuration' };
    }

    const body = {
        type: 'channel.channel_points_custom_reward_redemption.add',
        version: '1',
        condition: { broadcaster_user_id: broadcasterUserId },
        transport: { method: 'webhook', callback: `${publicUrl}/twitch/event`, secret: eventSubSecret }
    };

    const result = await makeHelixRequest('post', '/eventsub/subscriptions', body);
    if (result.success) {
        logger.info({ broadcasterUserId, type: 'channel.channel_points_custom_reward_redemption.add' },
            'Successfully subscribed to channel points redemption.add');
        clearEventSubSubscriptionsCache();
    }
    return result;
}

// --- Shared Chat EventSub Subscriptions ---

export async function subscribeSharedChatBegin(broadcasterUserId) {
    const { publicUrl, eventSubSecret } = config.twitch;
    if (!publicUrl || !eventSubSecret) return { success: false, error: 'Missing configuration' };

    const body = {
        type: 'channel.shared_chat.begin',
        version: '1',
        condition: { broadcaster_user_id: broadcasterUserId },
        transport: { method: 'webhook', callback: `${publicUrl}/twitch/event`, secret: eventSubSecret }
    };
    return await makeHelixRequest('post', '/eventsub/subscriptions', body);
}

export async function subscribeSharedChatUpdate(broadcasterUserId) {
    const { publicUrl, eventSubSecret } = config.twitch;
    if (!publicUrl || !eventSubSecret) return { success: false, error: 'Missing configuration' };

    const body = {
        type: 'channel.shared_chat.update',
        version: '1',
        condition: { broadcaster_user_id: broadcasterUserId },
        transport: { method: 'webhook', callback: `${publicUrl}/twitch/event`, secret: eventSubSecret }
    };
    return await makeHelixRequest('post', '/eventsub/subscriptions', body);
}

export async function subscribeSharedChatEnd(broadcasterUserId) {
    const { publicUrl, eventSubSecret } = config.twitch;
    if (!publicUrl || !eventSubSecret) return { success: false, error: 'Missing configuration' };

    const body = {
        type: 'channel.shared_chat.end',
        version: '1',
        condition: { broadcaster_user_id: broadcasterUserId },
        transport: { method: 'webhook', callback: `${publicUrl}/twitch/event`, secret: eventSubSecret }
    };
    return await makeHelixRequest('post', '/eventsub/subscriptions', body);
}

export async function subscribeAllManagedChannels() {
    try {
        if (!config.twitch.publicUrl) {
            logger.error('Missing PUBLIC_URL in config. Cannot subscribe or deduplicate EventSub webhooks.');
            return { successful: [], failed: [], total: 0, error: 'Missing PUBLIC_URL' };
        }

        const { getActiveManagedChannels } = await import('./channelManager.js');
        const activeChannels = await getActiveManagedChannels();
        const results = { successful: [], failed: [], total: activeChannels.length };

        // PRE-FETCH EXISTING SUBSCRIPTIONS for deduplication and cleanup
        const existingSubsResult = await getEventSubSubscriptions('Startup deduplication fetch', false);
        const existingSubs = existingSubsResult?.data?.data || [];
        
        const activeSubKeys = new Set();
        let cleanedUpCount = 0;
        let skippedCount = 0;
        const currentCallback = `${config.twitch.publicUrl}/twitch/event`;
        
        for (const sub of existingSubs) {
            const isStaleStatus = ['authorization_revoked', 'notification_failures_exceeded', 'user_removed', 'version_removed'].includes(sub.status);
            const isStaleCallback = sub.transport?.callback !== currentCallback;
            
            if (isStaleStatus || isStaleCallback) {
                const deleteResult = await deleteEventSubSubscription(sub.id);
                if (deleteResult.success) {
                    cleanedUpCount++;
                } else {
                    logger.warn({ subId: sub.id, error: deleteResult.error }, 'Failed to delete stale EventSub subscription');
                }
            } else if (sub.status === 'enabled' || sub.status === 'webhook_callback_verification_pending') {
                const key = getSubKey(sub.type, sub.condition);
                activeSubKeys.add(key);
            }
        }
        
        if (cleanedUpCount > 0) {
            logger.info({ cleanedUpCount }, 'Cleaned up stale EventSub subscriptions');
        }

        const { getBotUserId } = await import('./chatClient.js');
        const botUserId = await getBotUserId();
        if (!botUserId) {
            logger.error('CRITICAL: Could not determine bot user ID. channel.chat.message subscriptions will fail.');
        }

        const skipIfActive = async (type, condition, subscribeFn) => {
            const key = getSubKey(type, condition);
            if (activeSubKeys.has(key)) {
                skippedCount++;
                return { success: true, alreadyExists: true };
            }
            return await subscribeFn();
        };

        const unauthChatBroadcasterIds = new Set();

        for (const channel of activeChannels) {
            const channelName = channel.name;
            try {
                let userId = channel.twitchUserId ? String(channel.twitchUserId) : null;

                // Only fall back to login-name lookup if no ID was stored in Firestore
                if (!userId) {
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
                    userId = userResponse.id;
                }

                const onlineSubResult = await skipIfActive('stream.online', { broadcaster_user_id: userId }, () => subscribeStreamOnline(userId));
                const offlineSubResult = await skipIfActive('stream.offline', { broadcaster_user_id: userId }, () => subscribeStreamOffline(userId));
                
                let chatSubResult = { success: false, error: 'Missing botUserId' };
                if (botUserId) {
                    const chatCondition = { broadcaster_user_id: userId, user_id: botUserId };
                    chatSubResult = await skipIfActive('channel.chat.message', chatCondition, () => subscribeChannelChatMessage(userId));
                    if (!chatSubResult.success && chatSubResult.error && chatSubResult.error.includes('403')) {
                        unauthChatBroadcasterIds.add(userId);
                    }
                }
                
                const redemptionSubResult = await skipIfActive('channel.channel_points_custom_reward_redemption.add', { broadcaster_user_id: userId }, () => subscribeChannelPointsRedemptionAdd(userId));

                // Celebration-related EventSub subscriptions (best-effort: 403 from missing
                // scopes is logged but does not block the rest of the subscriptions)
                const followSubResult = await skipIfActive('channel.follow', { broadcaster_user_id: userId, moderator_user_id: userId }, () => subscribeChannelFollow(userId));
                const subscribeSubResult = await skipIfActive('channel.subscribe', { broadcaster_user_id: userId }, () => subscribeChannelSubscribe(userId));
                const giftSubResult = await skipIfActive('channel.subscription.gift', { broadcaster_user_id: userId }, () => subscribeChannelSubscriptionGift(userId));
                const raidSubResult = await skipIfActive('channel.raid', { to_broadcaster_user_id: userId }, () => subscribeChannelRaid(userId));

                const coreSuccess = onlineSubResult.success && offlineSubResult.success && chatSubResult.success && redemptionSubResult.success;
                if (coreSuccess) {
                    results.successful.push({ channel: channelName, userId });
                } else {
                    const failures = [];
                    if (!onlineSubResult.success) failures.push('stream.online');
                    if (!offlineSubResult.success) failures.push('stream.offline');
                    if (!chatSubResult.success) failures.push('channel.chat.message');
                    if (!redemptionSubResult.success) failures.push('channel.channel_points_custom_reward_redemption.add');
                    results.failed.push({ channel: channelName, error: `Failed: ${failures.join(', ')}` });
                }

                // Log celebration subscription failures separately (non-critical)
                const celebrationFailures = [];
                let hasUnexpectedFailure = false;
                const checkCelebration = (res, name) => {
                    if (!res.success) {
                        celebrationFailures.push(name);
                        if (!res.error || !res.error.includes('403')) {
                            hasUnexpectedFailure = true;
                        }
                    }
                };
                
                checkCelebration(followSubResult, 'channel.follow');
                checkCelebration(subscribeSubResult, 'channel.subscribe');
                checkCelebration(giftSubResult, 'channel.subscription.gift');
                checkCelebration(raidSubResult, 'channel.raid');

                if (hasUnexpectedFailure) {
                    logger.warn({ channelName, userId, failed: celebrationFailures }, 'Some celebration EventSub subscriptions failed unexpectedly');
                }
            } catch (error) {
                logger.error({ err: error, channelName }, 'Error subscribing channel to EventSub');
                results.failed.push({ channel: channelName, error: error.message });
            }
        }

        if (unauthChatBroadcasterIds.size > 0) {
            logger.warn({ 
                count: unauthChatBroadcasterIds.size, 
                ids: Array.from(unauthChatBroadcasterIds) 
            }, 'Channels missing bot authorization for chat messages');
        }
        
        if (skippedCount > 0) {
            logger.info({ skippedCount }, 'Skipped existing EventSub subscriptions during batch processing');
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
        const subsRes = await getEventSubSubscriptions(`Check ad break subscription for broadcaster ${broadcasterUserId}`);
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