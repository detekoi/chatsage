// scripts/migrate-channels-to-firestore.js
import { Firestore } from '@google-cloud/firestore';
import { config } from 'dotenv';
import { getSecretValue, initializeSecretManager } from '../src/lib/secretManager.js';
import logger from '../src/lib/logger.js';

// Initialize environment variables
config();

// Collection name for managed channels
const MANAGED_CHANNELS_COLLECTION = 'managedChannels';

/**
 * Migrates channels from environment variables or Secret Manager to Firestore.
 * This is a one-time migration script.
 */
async function main() {
    try {
        logger.info('Initializing Firestore client...');
        const db = new Firestore();
        
        // Test Firestore connection
        const testRef = db.collection(MANAGED_CHANNELS_COLLECTION).doc('test');
        await testRef.set({ test: true });
        await testRef.delete();
        logger.info('Firestore connection successful.');
        
        logger.info('Initializing Secret Manager...');
        await initializeSecretManager();
        
        // Get channels from environment or Secret Manager
        let channels = [];
        if (process.env.TWITCH_CHANNELS) {
            logger.info('Reading channels from TWITCH_CHANNELS environment variable...');
            channels = process.env.TWITCH_CHANNELS
                .split(',')
                .map(ch => ch.trim().toLowerCase())
                .filter(ch => ch);
            logger.info(`Found ${channels.length} channels in environment variable.`);
        } else if (process.env.TWITCH_CHANNELS_SECRET_NAME) {
            logger.info('Reading channels from Secret Manager...');
            const secretName = process.env.TWITCH_CHANNELS_SECRET_NAME;
            const channelsString = await getSecretValue(secretName);
            if (channelsString) {
                channels = channelsString
                    .split(',')
                    .map(ch => ch.trim().toLowerCase())
                    .filter(ch => ch);
                logger.info(`Found ${channels.length} channels in Secret Manager.`);
            } else {
                logger.error('Failed to load channels from Secret Manager.');
                process.exit(1);
            }
        } else {
            logger.error('No channels found in environment or Secret Manager. Set TWITCH_CHANNELS or TWITCH_CHANNELS_SECRET_NAME.');
            process.exit(1);
        }
        
        // Check if channels already exist in Firestore
        const existingChannels = [];
        const snapshot = await db.collection(MANAGED_CHANNELS_COLLECTION).get();
        snapshot.forEach(doc => {
            existingChannels.push(doc.id.toLowerCase());
        });
        
        logger.info(`Found ${existingChannels.length} channels already in Firestore.`);
        
        // Filter out channels that already exist
        const newChannels = channels.filter(ch => !existingChannels.includes(ch));
        logger.info(`Adding ${newChannels.length} new channels to Firestore...`);
        
        if (newChannels.length === 0) {
            logger.info('No new channels to add. Exiting.');
            process.exit(0);
        }
        
        // Add channels to Firestore
        const batch = db.batch();
        for (const channel of newChannels) {
            const docRef = db.collection(MANAGED_CHANNELS_COLLECTION).doc(channel);
            batch.set(docRef, {
                channelName: channel,
                isActive: true,
                addedBy: 'migration-script',
                addedAt: Firestore.FieldValue.serverTimestamp(),
                lastStatusChange: Firestore.FieldValue.serverTimestamp(),
                displayName: channel,
                notes: 'Migrated from environment variables or Secret Manager'
            });
        }
        
        await batch.commit();
        logger.info(`Successfully migrated ${newChannels.length} channels to Firestore.`);
        
        // List all channels in Firestore after migration
        const finalSnapshot = await db.collection(MANAGED_CHANNELS_COLLECTION).get();
        const allChannels = [];
        finalSnapshot.forEach(doc => {
            allChannels.push({
                channelName: doc.id,
                ...doc.data()
            });
        });
        
        logger.info(`Total channels in Firestore after migration: ${allChannels.length}`);
        console.log(JSON.stringify(allChannels.map(ch => ch.channelName), null, 2));
        
        logger.info('Migration completed successfully!');
    } catch (error) {
        logger.error({ err: error }, 'Error during migration:');
        process.exit(1);
    }
}

// Run the migration
main();