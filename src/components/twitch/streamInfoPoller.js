import logger from '../../lib/logger.js';
import { getChannelInformation, getLiveStreams } from './helixClient.js';
// No need to import helixClient directly here, pass it in
// No need to import contextManager directly here, pass it in

let pollingIntervalId = null;

/**
 * Fetches stream information for a batch of channels.
 * @param {Array<{channelName: string, broadcasterId: string}>} channels - Batch of channels with IDs.
 * @param {import('./helixClient.js').HelixClient} helixClient - Initialized Helix client instance (still needed for potential future direct calls).
 * @param {import('../context/contextManager.js').ContextManager} contextManager - Context manager instance.
 */
async function fetchBatch(channels, helixClient, contextManager) {
    if (!channels || channels.length === 0) return;

    const broadcasterIds = channels.map(c => c.broadcasterId);
    logger.debug(`Polling stream info for IDs: ${broadcasterIds.join(', ')}`);

    try {
        // First, check which streams are actually live
        const liveStreams = await getLiveStreams(broadcasterIds);
        const liveStreamIds = new Set(liveStreams.map(stream => stream.user_id));
        
        logger.debug(`Found ${liveStreams.length} live streams out of ${channels.length} channels checked`);

        // For live streams, fetch detailed channel information
        const liveChannelIds = broadcasterIds.filter(id => liveStreamIds.has(id));
        const channelInfoList = liveChannelIds.length > 0 ? await getChannelInformation(liveChannelIds) : [];

        // Create maps for easy lookup
        const liveStreamMap = new Map(liveStreams.map(stream => [stream.user_id, stream]));
        const infoMap = new Map(channelInfoList.map(info => [info.broadcaster_id, info]));

        // Update context for each channel in the batch
        for (const channel of channels) {
            const isLive = liveStreamIds.has(channel.broadcasterId);
            
            if (isLive) {
                const streamInfo = liveStreamMap.get(channel.broadcasterId);
                const channelInfo = infoMap.get(channel.broadcasterId);
                
                // Stream is live, update with live context
                contextManager.updateStreamContext(channel.channelName, {
                    game: streamInfo?.game_name || channelInfo?.game_name || 'Unknown',
                    title: streamInfo?.title || channelInfo?.title || 'Untitled Stream',
                    tags: channelInfo?.tags || [],
                    language: channelInfo?.broadcaster_language || 'en',
                    viewerCount: streamInfo?.viewer_count || 0,
                    startedAt: streamInfo?.started_at || null,
                });
                
                logger.debug(`Updated live stream context for ${channel.channelName}: ${streamInfo?.game_name} (${streamInfo?.viewer_count} viewers)`);
            } else {
                // Stream is offline - clear the context to indicate it's not live
                // This ensures the keep-alive check knows the stream is offline
                contextManager.clearStreamContext(channel.channelName);
                logger.debug(`Cleared context for offline stream: ${channel.channelName}`);
            }
        }
    } catch (error) {
        // Errors during the API call itself are logged by helixClient interceptor
        logger.error({ err: error, ids: broadcasterIds }, 'Error fetching stream info batch.');
        // Record errors for all channels in this failed batch
        for (const channel of channels) {
            contextManager.recordStreamContextFetchError(channel.channelName);
        }
    }
}

/**
 * Starts the periodic polling for stream information.
 * @param {string[]} initialChannelNames - List of channel names configured for the bot.
 * @param {number} intervalMs - Polling interval in milliseconds.
 * @param {import('./helixClient.js').HelixClient} helixClient - Initialized Helix client instance.
 * @param {import('../context/contextManager.js').ContextManager} contextManager - Context manager instance.
 * @returns {NodeJS.Timeout} The interval timer ID.
 */
function startStreamInfoPolling(initialChannelNames, intervalMs, helixClient, contextManager) {
    if (pollingIntervalId) {
        logger.warn('Stream info polling is already running.');
        return pollingIntervalId;
    }

    logger.info(`Starting stream info polling every ${intervalMs / 1000} seconds.`);

    // Define the polling function
    const poll = async () => {
        logger.debug('Executing stream info poll cycle...');
        try {
            // Get the list of channels *with* broadcaster IDs from context manager
            // This might involve fetching missing IDs on the fly if the first poll cycle
            const channelsToPoll = await contextManager.getChannelsForPolling();

            if (channelsToPoll.length === 0) {
                logger.debug('No channels with known broadcaster IDs to poll yet.');
                return;
            }

            // Batch requests (Twitch API limit is 100 IDs per request)
            const batchSize = 100;
            for (let i = 0; i < channelsToPoll.length; i += batchSize) {
                const batch = channelsToPoll.slice(i, i + batchSize);
                await fetchBatch(batch, helixClient, contextManager);
                // Optional: Add a small delay between batches if hitting rate limits aggressively
                // await new Promise(resolve => setTimeout(resolve, 200));
            }
        } catch (error) {
            // Errors fetching the list of channels to poll (e.g., initial ID lookup failures)
            logger.error({ err: error }, 'Error during stream info polling cycle setup (getChannelsForPolling).');
        }
    };

    // Run immediately first time, then start interval
    poll().catch(err => logger.error({ err }, "Error during initial poll execution.")); // Handle error for initial run
    pollingIntervalId = setInterval(poll, intervalMs);

    return pollingIntervalId;
}

/**
 * Stops the periodic polling for stream information.
 */
function stopStreamInfoPolling() {
    if (pollingIntervalId) {
        logger.info('Stopping stream info polling.');
        clearInterval(pollingIntervalId);
        pollingIntervalId = null;
    } else {
        logger.warn('Stream info polling is not running.');
    }
}

export { startStreamInfoPolling, stopStreamInfoPolling };