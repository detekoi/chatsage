import fetch from 'node-fetch';
import { getHelixClient } from './helixClient.js';
import logger from '../../lib/logger.js';
import { getAppAccessToken } from './auth.js';
import config from '../../config/index.js';

/**
 * Subscribe to stream.online EventSub for a specific broadcaster
 * @param {string} broadcasterUserId - The Twitch user ID of the broadcaster
 * @returns {Promise<Object>} The subscription response or error
 */
export async function subscribeStreamOnline(broadcasterUserId) {
    try {
        const token = await getAppAccessToken();
        const publicUrl = process.env.PUBLIC_URL;
        const eventSubSecret = process.env.TWITCH_EVENTSUB_SECRET;

        if (!publicUrl) {
            throw new Error('PUBLIC_URL environment variable is not set');
        }

        if (!eventSubSecret) {
            throw new Error('TWITCH_EVENTSUB_SECRET environment variable is not set');
        }

        const body = {
            type: 'stream.online',
            version: '1',
            condition: { broadcaster_user_id: broadcasterUserId },
            transport: {
                method: 'webhook',
                callback: `${publicUrl}/twitch/event`,
                secret: eventSubSecret
            }
        };

        logger.info({ broadcasterUserId, callback: body.transport.callback }, 'Creating stream.online EventSub subscription');

        const response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
            method: 'POST',
            headers: {
                'Client-ID': config.twitch.clientId,
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        const responseData = await response.json();

        if (!response.ok) {
            logger.error({ 
                status: response.status, 
                statusText: response.statusText,
                error: responseData,
                broadcasterUserId 
            }, 'EventSub subscription failed');
            return { success: false, error: responseData };
        }

        logger.info({ 
            subscriptionId: responseData.data[0].id,
            broadcasterUserId,
            status: responseData.data[0].status 
        }, 'EventSub subscription created successfully');

        return { success: true, data: responseData.data[0] };

    } catch (error) {
        logger.error({ err: error, broadcasterUserId }, 'Error creating EventSub subscription');
        return { success: false, error: error.message };
    }
}

/**
 * Get all active EventSub subscriptions
 * @returns {Promise<Object>} List of subscriptions or error
 */
export async function getEventSubSubscriptions() {
    try {
        const token = await getAppAccessToken();

        const response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
            headers: {
                'Client-ID': config.twitch.clientId,
                'Authorization': `Bearer ${token}`
            }
        });

        const responseData = await response.json();

        if (!response.ok) {
            logger.error({ 
                status: response.status, 
                statusText: response.statusText,
                error: responseData 
            }, 'Failed to get EventSub subscriptions');
            return { success: false, error: responseData };
        }

        return { success: true, data: responseData.data };

    } catch (error) {
        logger.error({ err: error }, 'Error getting EventSub subscriptions');
        return { success: false, error: error.message };
    }
}

/**
 * Delete an EventSub subscription
 * @param {string} subscriptionId - The subscription ID to delete
 * @returns {Promise<Object>} Success status or error
 */
export async function deleteEventSubSubscription(subscriptionId) {
    try {
        const token = await getAppAccessToken();

        const response = await fetch(`https://api.twitch.tv/helix/eventsub/subscriptions?id=${subscriptionId}`, {
            method: 'DELETE',
            headers: {
                'Client-ID': config.twitch.clientId,
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) {
            const responseData = await response.json();
            logger.error({ 
                status: response.status, 
                statusText: response.statusText,
                error: responseData,
                subscriptionId 
            }, 'Failed to delete EventSub subscription');
            return { success: false, error: responseData };
        }

        logger.info({ subscriptionId }, 'EventSub subscription deleted successfully');
        return { success: true };

    } catch (error) {
        logger.error({ err: error, subscriptionId }, 'Error deleting EventSub subscription');
        return { success: false, error: error.message };
    }
}

/**
 * Subscribe to stream.online events for all active managed channels
 * @returns {Promise<Object>} Summary of subscription results
 */
export async function subscribeAllManagedChannels() {
    try {
        const { getActiveManagedChannels } = await import('./channelManager.js');
        const { getUsersByLogin } = await import('./helixClient.js');
        
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

                // Subscribe to both stream.online and stream.offline events
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

        logger.info({ 
            successful: results.successful.length,
            failed: results.failed.length,
            total: results.total 
        }, 'EventSub subscription batch completed');

        return results;

    } catch (error) {
        logger.error({ err: error }, 'Error in subscribeAllManagedChannels');
        return { successful: [], failed: [], total: 0, error: error.message };
    }
}

/**
 * Creates an EventSub subscription for a stream going offline.
 * @param {string} broadcasterUserId - The ID of the broadcaster.
 * @returns {Promise<Object>} The result of the subscription request.
 */
export async function subscribeStreamOffline(broadcasterUserId) {
    // Get the helixClient instance which has the config attached
    const helixClient = getHelixClient(); 
    // Now correctly get the config from the client instance
    const { publicUrl, eventSubSecret } = helixClient.config.twitch; 

    if (!publicUrl || !eventSubSecret) {
        logger.error('Missing PUBLIC_URL or TWITCH_EVENTSUB_SECRET in config');
        return { success: false, error: 'Missing configuration' };
    }

    try {
        const body = {
            type: 'stream.offline',
            version: '1',
            condition: { broadcaster_user_id: broadcasterUserId },
            transport: {
                method: 'webhook',
                callback: `${publicUrl}/twitch/event`,
                secret: eventSubSecret
            }
        };

        // Use the existing helixClient instance to make the request
        await helixClient.post('/eventsub/subscriptions', body);
        logger.info({ broadcasterUserId }, 'Successfully subscribed to stream.offline');
        return { success: true };
    } catch (error) {
        logger.error({ err: error, broadcasterUserId }, 'Error subscribing to stream.offline');
        return { success: false, error: error.message };
    }
}
