import logger from '../../lib/logger.js';
import { getChannelInformation } from './helixClient.js';
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
        // Fetch channel info using the imported function directly
        const channelInfoList = await getChannelInformation(broadcasterIds);

        // Create a map for easy lookup by ID
        const infoMap = new Map(channelInfoList.map(info => [info.broadcaster_id, info]));

        // Update context for each channel in the batch
        for (const channel of channels) {
            const info = infoMap.get(channel.broadcasterId);
            if (info) {
                // Found info, update context
                contextManager.updateStreamContext(channel.channelName, {
                    game: info.game_name,
                    title: info.title,
                    tags: info.tags,
                    language: info.broadcaster_language,
                    // Add other fields from 'info' if needed by contextManager
                });
            } else {
                // Info not found for this specific ID in the response (might be offline, banned, deleted?)
                // Record it as a fetch "error" or handle appropriately - maybe mark as offline?
                logger.warn(`No channel info returned from Helix for ${channel.channelName} (ID: ${channel.broadcasterId}) in this batch.`);
                // Let's treat missing info as a "soft" error for now
                contextManager.recordStreamContextFetchError(channel.channelName);
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