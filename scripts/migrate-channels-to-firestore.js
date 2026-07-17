// scripts/migrate-channels-to-firestore.js
//
// Migrates channels from environment variables or Secret Manager to Firestore.
// IMPORTANT: Documents are keyed by Twitch User ID (not channel name) because
// the OAuth login flow (oauth.router.ts) looks up managedChannels by twitchUser.id.
//
import { Firestore } from '@google-cloud/firestore';
import { config } from 'dotenv';
import { getSecretValue, initializeSecretManager } from '../src/lib/secretManager.js';
import { initializeHelixClient, getUsersByLogin } from '../src/components/twitch/helixClient.js';
import logger from '../src/lib/logger.js';

// Initialize environment variables
config();

// Collection name for managed channels
const MANAGED_CHANNELS_COLLECTION = 'managedChannels';

/**
 * Resolves channel login names to Twitch User IDs via the Helix API.
 * Processes in batches of 100 (Helix API limit).
 * @param {string[]} loginNames - Array of lowercase channel login names
 * @returns {Promise<Array<{login: string, id: string, displayName: string}>>}
 */
async function resolveChannelIds(loginNames) {
    const results = [];
    // Helix allows up to 100 logins per request
    for (let i = 0; i < loginNames.length; i += 100) {
        const batch = loginNames.slice(i, i + 100);
        const users = await getUsersByLogin(batch);
        for (const user of users) {
            results.push({
                login: user.login.toLowerCase(),
                id: user.id,
                displayName: user.display_name || user.login,
            });
        }
    }
    return results;
}

/**
 * Migrates channels from environment variables or Secret Manager to Firestore.
 * Documents are keyed by Twitch User ID so that the OAuth flow can find them.
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

        logger.info('Initializing Helix client...');
        await initializeHelixClient();

        // Get channels from environment or Secret Manager
        let channelNames = [];
        if (process.env.TWITCH_CHANNELS) {
            logger.info('Reading channels from TWITCH_CHANNELS environment variable...');
            channelNames = process.env.TWITCH_CHANNELS
                .split(',')
                .map(ch => ch.trim().toLowerCase())
                .filter(ch => ch);
            logger.info(`Found ${channelNames.length} channels in environment variable.`);
        } else if (process.env.TWITCH_CHANNELS_SECRET_NAME) {
            logger.info('Reading channels from Secret Manager...');
            const secretName = process.env.TWITCH_CHANNELS_SECRET_NAME;
            const channelsString = await getSecretValue(secretName);
            if (channelsString) {
                channelNames = channelsString
                    .split(',')
                    .map(ch => ch.trim().toLowerCase())
                    .filter(ch => ch);
                logger.info(`Found ${channelNames.length} channels in Secret Manager.`);
            } else {
                logger.error('Failed to load channels from Secret Manager.');
                process.exit(1);
            }
        } else {
            logger.error('No channels found in environment or Secret Manager. Set TWITCH_CHANNELS or TWITCH_CHANNELS_SECRET_NAME.');
            process.exit(1);
        }

        // Resolve login names → Twitch User IDs via Helix API
        logger.info(`Resolving Twitch User IDs for ${channelNames.length} channel(s)...`);
        const resolved = await resolveChannelIds(channelNames);

        const unresolved = channelNames.filter(
            name => !resolved.some(r => r.login === name)
        );
        if (unresolved.length > 0) {
            logger.warn({ unresolved }, `Could not resolve ${unresolved.length} channel(s) via Helix API. They will be skipped.`);
        }

        logger.info(`Resolved ${resolved.length} / ${channelNames.length} channels.`);

        // Build a set of existing Twitch User IDs and channel names already in Firestore
        const existingDocIds = new Set();
        const existingChannelNames = new Set();
        const snapshot = await db.collection(MANAGED_CHANNELS_COLLECTION).get();
        snapshot.forEach(doc => {
            existingDocIds.add(doc.id);
            const data = doc.data();
            if (data?.channelName) {
                existingChannelNames.add(data.channelName.toLowerCase());
            }
        });

        logger.info(`Found ${existingDocIds.size} documents already in Firestore.`);

        // Filter to only channels that don't already have a doc keyed by their user ID
        // AND whose channel name isn't already present (avoid duplicates)
        const newChannels = resolved.filter(ch =>
            !existingDocIds.has(ch.id) && !existingChannelNames.has(ch.login)
        );

        logger.info(`Adding ${newChannels.length} new channels to Firestore...`);

        if (newChannels.length === 0) {
            logger.info('No new channels to add. Exiting.');
            process.exit(0);
        }

        // Add channels to Firestore — keyed by Twitch User ID
        const batch = db.batch();
        for (const channel of newChannels) {
            const docRef = db.collection(MANAGED_CHANNELS_COLLECTION).doc(channel.id);
            batch.set(docRef, {
                channelName: channel.login,
                twitchUserId: channel.id,
                isActive: true,
                addedBy: 'migration-script',
                addedAt: Firestore.FieldValue.serverTimestamp(),
                lastStatusChange: Firestore.FieldValue.serverTimestamp(),
                displayName: channel.displayName,
                notes: 'Migrated from environment variables or Secret Manager'
            });
        }

        await batch.commit();
        logger.info(`Successfully migrated ${newChannels.length} channels to Firestore.`);

        // List all channels in Firestore after migration
        const finalSnapshot = await db.collection(MANAGED_CHANNELS_COLLECTION).get();
        const allChannels = [];
        finalSnapshot.forEach(doc => {
            const data = doc.data();
            allChannels.push({
                docId: doc.id,
                channelName: data.channelName || doc.id,
                twitchUserId: data.twitchUserId || null,
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