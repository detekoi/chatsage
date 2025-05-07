// scripts/test-channel-manager.js
import logger from '../src/lib/logger.js';
import { 
    initializeChannelManager, 
    getActiveManagedChannels,
    getAllManagedChannels
} from '../src/components/twitch/channelManager.js';

/**
 * Simple test script for the channel manager.
 * Useful to verify the connection to Firestore and test functionality.
 */
async function main() {
    try {
        logger.info('Initializing Channel Manager...');
        await initializeChannelManager();
        
        logger.info('Fetching active managed channels...');
        const activeChannels = await getActiveManagedChannels();
        logger.info(`Found ${activeChannels.length} active managed channels:`);
        console.log(activeChannels);
        
        logger.info('Fetching all managed channels (both active and inactive)...');
        const allChannels = await getAllManagedChannels();
        logger.info(`Found ${allChannels.length} total managed channels:`);
        console.log(JSON.stringify(allChannels, null, 2));
        
        logger.info('Test completed successfully!');
    } catch (error) {
        logger.error({ err: error }, 'Error during channel manager test.');
        process.exit(1);
    }
}

// Run the test
main();