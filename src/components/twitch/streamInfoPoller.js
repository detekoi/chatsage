import logger from '../../lib/logger.js';
import { getChannelInformation, getLiveStreams } from './helixClient.js';
import { getContextManager } from '../context/contextManager.js';
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
                    gameId: streamInfo?.game_id || channelInfo?.game_id || null,
                    title: streamInfo?.title || channelInfo?.title || 'Untitled Stream',
                    // Prefer live tags from Get Streams; fallback to channel tags
                    tags: (streamInfo?.tags ?? channelInfo?.tags ?? []),
                    language: channelInfo?.broadcaster_language || 'en',
                    viewerCount: streamInfo?.viewer_count || 0,
                    startedAt: streamInfo?.started_at || null,
                });
                
                logger.debug(`Updated live stream context for ${channel.channelName}: ${streamInfo?.game_name} (${streamInfo?.viewer_count} viewers)`);
            } else {
                // Stream is offline (for this poll). Use a grace mechanism before clearing context
                try {
                    contextManager.recordOfflineMiss(channel.channelName);
                    logger.debug(`Recorded offline miss for ${channel.channelName}`);
                } catch (e) {
                    // Fallback to immediate clear only if recordOfflineMiss is unavailable
                    contextManager.clearStreamContext(channel.channelName);
                    logger.debug(`Cleared context for offline stream (fallback): ${channel.channelName}`);
                }
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
 * @returns {Promise<NodeJS.Timeout>} Promise that resolves with interval timer ID after first poll completes.
 */
async function startStreamInfoPolling(initialChannelNames, intervalMs, helixClient, contextManager) {
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

    // Run immediately first time and await completion, then start interval
    await poll().catch(err => logger.error({ err }, "Error during initial poll execution."));
    pollingIntervalId = setInterval(poll, intervalMs);

    logger.info('First poll cycle complete - context manager populated with current stream states');
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

/**
 * Gets the current game information for a channel, using cached context first,
 * then falling back to Helix lookups if needed. When live, updates context.
 * @param {string} channelName - The channel name without '#'
 * @returns {Promise<{gameName: string, streamTitle: string, viewerCount: number} | null>}
 */
export async function getCurrentGameInfo(channelName) {
    try {
        const contextManager = getContextManager();
        const streamContext = contextManager.getContextForLLM(channelName, 'system', 'game info lookup');

        const gameNameFromContext = streamContext?.streamGame || 'Unknown';
        const titleFromContext = streamContext?.streamTitle || 'Unknown';
        let viewerCount = 0;
        if (streamContext?.viewerCount && !isNaN(parseInt(streamContext.viewerCount))) {
            viewerCount = parseInt(streamContext.viewerCount);
        }

        const hasReliableGame = gameNameFromContext && gameNameFromContext !== 'Unknown' && gameNameFromContext !== 'N/A';
        if (!hasReliableGame) {
            // Resolve broadcaster id
            const broadcasterId = await contextManager.getBroadcasterId(channelName);
            if (!broadcasterId) {
                logger.warn({ channel: channelName }, 'Unable to resolve broadcasterId for on-demand game lookup');
                return null;
            }

            // Prefer live stream details
            const live = await getLiveStreams([broadcasterId]);
            const liveStream = Array.isArray(live) && live.length > 0 ? live[0] : null;

            let mergedGameName = gameNameFromContext;
            let mergedTitle = titleFromContext;
            let mergedViewerCount = viewerCount;
            let mergedStartedAt = null;
            let mergedGameId = null;
            let mergedTags = [];
            let mergedLanguage = null;

            if (liveStream) {
                mergedGameName = liveStream.game_name || mergedGameName;
                mergedGameId = liveStream.game_id || null;
                mergedTitle = liveStream.title || mergedTitle;
                mergedViewerCount = typeof liveStream.viewer_count === 'number' ? liveStream.viewer_count : mergedViewerCount;
                mergedStartedAt = liveStream.started_at || null;
                if (Array.isArray(liveStream.tags)) mergedTags = liveStream.tags;
            }

            const channelInfos = await getChannelInformation([broadcasterId]);
            const channelInfo = Array.isArray(channelInfos) && channelInfos.length > 0 ? channelInfos[0] : null;
            if (channelInfo) {
                if (!mergedGameName) mergedGameName = channelInfo.game_name || mergedGameName;
                if (!mergedGameId) mergedGameId = channelInfo.game_id || mergedGameId;
                if (!mergedTitle) mergedTitle = channelInfo.title || mergedTitle;
                if (mergedTags.length === 0 && Array.isArray(channelInfo.tags)) mergedTags = channelInfo.tags;
                mergedLanguage = channelInfo.broadcaster_language || mergedLanguage;
            }

            if (liveStream) {
                contextManager.updateStreamContext(channelName, {
                    game: mergedGameName || 'Unknown',
                    gameId: mergedGameId || null,
                    title: mergedTitle || 'Untitled Stream',
                    tags: mergedTags || [],
                    language: mergedLanguage || 'en',
                    viewerCount: mergedViewerCount || 0,
                    startedAt: mergedStartedAt || null,
                });
            }

            if (mergedGameName && mergedGameName !== 'Unknown' && mergedGameName !== 'N/A') {
                return {
                    gameName: mergedGameName,
                    streamTitle: mergedTitle || 'Unknown',
                    viewerCount: mergedViewerCount || 0,
                };
            }
        }

        return {
            gameName: gameNameFromContext !== 'N/A' ? gameNameFromContext : 'Unknown',
            streamTitle: titleFromContext !== 'N/A' ? titleFromContext : 'Unknown',
            viewerCount,
        };
    } catch (error) {
        logger.error({ err: error, channel: channelName }, 'Error resolving current game info');
        return null;
    }
}