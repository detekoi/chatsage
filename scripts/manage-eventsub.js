#!/usr/bin/env node

// scripts/manage-eventsub.js
// Utility script to manage Twitch EventSub subscriptions

import { subscribeAllManagedChannels, getEventSubSubscriptions, deleteEventSubSubscription } from '../src/components/twitch/twitchSubs.js';
import { initializeAutoChatStorage, getChannelAutoChatConfig } from '../src/components/context/autoChatStorage.js';
import { getUsersByLogin } from '../src/components/twitch/helixClient.js';
import { subscribeChannelAdBreakBegin } from '../src/components/twitch/twitchSubs.js';
import { initializeSecretManager } from '../src/lib/secretManager.js';
import { initializeChannelManager } from '../src/components/twitch/channelManager.js';
import { initializeHelixClient } from '../src/components/twitch/helixClient.js';
import config from '../src/config/index.js';
import logger from '../src/lib/logger.js';

async function listSubscriptions() {
    logger.info('Fetching all EventSub subscriptions...');
    const result = await getEventSubSubscriptions();
    
    if (result.success) {
        console.log('\n=== EventSub Subscriptions ===');
        const subscriptions = result.data.data || [];
        if (subscriptions.length === 0) {
            console.log('No subscriptions found.');
        } else {
            subscriptions.forEach((sub, index) => {
                console.log(`${index + 1}. ID: ${sub.id}`);
                console.log(`   Type: ${sub.type}`);
                console.log(`   Status: ${sub.status}`);
                console.log(`   Condition: ${JSON.stringify(sub.condition)}`);
                console.log(`   Created: ${sub.created_at}`);
                console.log('');
            });
        }
    } else {
        logger.error({ error: result.error }, 'Failed to fetch subscriptions');
    }
}

async function subscribeAll() {
    logger.info('Subscribing all managed channels to stream.online events...');
    const result = await subscribeAllManagedChannels();
    
    console.log('\n=== Subscription Results ===');
    console.log(`Total channels: ${result.total}`);
    console.log(`Successful: ${result.successful.length}`);
    console.log(`Failed: ${result.failed.length}`);
    
    if (result.successful.length > 0) {
        console.log('\nSuccessful subscriptions:');
        result.successful.forEach(sub => {
            console.log(`- ${sub.channel} (ID: ${sub.subscriptionId})`);
        });
    }
    
    if (result.failed.length > 0) {
        console.log('\nFailed subscriptions:');
        result.failed.forEach(fail => {
            console.log(`- ${fail.channel}: ${fail.error}`);
        });
    }
}

async function subscribeAdsForEnabledChannels() {
    logger.info('Subscribing all managed channels with ads enabled to channel.ad_break.begin...');
    const { getActiveManagedChannels } = await import('../src/components/twitch/channelManager.js');
    const activeChannels = await getActiveManagedChannels();
    let success = 0;
    let failed = 0;
    for (const channelName of activeChannels) {
        try {
            const cfg = await getChannelAutoChatConfig(channelName);
            if (!cfg?.categories?.ads) continue;
            const userResponseArray = await getUsersByLogin([channelName]);
            const userId = userResponseArray?.[0]?.id;
            if (!userId) {
                logger.warn({ channelName }, 'Cannot subscribe ads: missing user id');
                failed++;
                continue;
            }
            const r = await subscribeChannelAdBreakBegin(userId);
            if (r?.success) success++; else failed++;
        } catch (e) {
            logger.error({ err: e, channelName }, 'Error subscribing ad break');
            failed++;
        }
    }
    console.log(`Ad break subscriptions result: success=${success}, failed=${failed}`);
}

async function deleteSubscription(subscriptionId) {
    logger.info({ subscriptionId }, 'Deleting EventSub subscription...');
    const result = await deleteEventSubSubscription(subscriptionId);
    
    if (result.success) {
        console.log(`Successfully deleted subscription: ${subscriptionId}`);
    } else {
        logger.error({ error: result.error }, 'Failed to delete subscription');
    }
}

async function deleteAll() {
    logger.info('Deleting all EventSub subscriptions...');
    const listResult = await getEventSubSubscriptions();
    
    if (!listResult.success) {
        logger.error({ error: listResult.error }, 'Failed to fetch subscriptions for deletion');
        return;
    }
    
    const subscriptions = listResult.data.data || [];
    if (subscriptions.length === 0) {
        console.log('No subscriptions to delete.');
        return;
    }
    
    console.log(`Found ${subscriptions.length} subscriptions to delete...`);
    
    for (const sub of subscriptions) {
        const result = await deleteEventSubSubscription(sub.id);
        if (result.success) {
            console.log(`✓ Deleted: ${sub.id} (${sub.type})`);
        } else {
            console.log(`✗ Failed to delete: ${sub.id} - ${result.error}`);
        }
    }
}

async function main() {
    const command = process.argv[2];
    const arg = process.argv[3];
    
    if (!command) {
        console.log(`
Usage: node scripts/manage-eventsub.js <command> [args]

Commands:
  list                    - List all EventSub subscriptions
  subscribe-all          - Subscribe all managed channels to stream.online
  delete <subscription_id> - Delete a specific subscription
  delete-all             - Delete all subscriptions
  
Examples:
  node scripts/manage-eventsub.js list
  node scripts/manage-eventsub.js subscribe-all
  node scripts/manage-eventsub.js delete abcd-1234-efgh-5678
  node scripts/manage-eventsub.js delete-all
        `);
        process.exit(1);
    }
    
    try {
        // Initialize required services
        logger.info('Initializing services...');
        initializeSecretManager();
        await initializeHelixClient(config.twitch);
        await initializeChannelManager();
        
        switch (command.toLowerCase()) {
            case 'list':
                await listSubscriptions();
                break;
            case 'subscribe-all':
                await subscribeAll();
                break;
            case 'subscribe-ads':
                await initializeAutoChatStorage();
                await subscribeAdsForEnabledChannels();
                break;
            case 'delete':
                if (!arg) {
                    console.error('Please provide a subscription ID to delete');
                    process.exit(1);
                }
                await deleteSubscription(arg);
                break;
            case 'delete-all':
                await deleteAll();
                break;
            default:
                console.error(`Unknown command: ${command}`);
                process.exit(1);
        }
        
        logger.info('Command completed successfully');
        process.exit(0);
        
    } catch (error) {
        logger.error({ err: error }, 'Script failed');
        process.exit(1);
    }
}

main();