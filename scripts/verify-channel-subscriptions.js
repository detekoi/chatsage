#!/usr/bin/env node

// scripts/verify-channel-subscriptions.js
// Verifies that all active managed channels have required EventSub subscriptions

import { getEventSubSubscriptions } from '../src/components/twitch/twitchSubs.js';
import { getActiveManagedChannels } from '../src/components/twitch/channelManager.js';
import { getUsersByLogin } from '../src/components/twitch/helixClient.js';
import { initializeHelixClient } from '../src/components/twitch/helixClient.js';
import { initializeChannelManager } from '../src/components/twitch/channelManager.js';
import { initializeSecretManager } from '../src/lib/secretManager.js';
import config from '../src/config/index.js';
import logger from '../src/lib/logger.js';

const REQUIRED_SUBSCRIPTION_TYPES = [
    'stream.online',
    'stream.offline'
];

async function verifyChannelSubscriptions() {
    try {
        // Initialize
        logger.info('Initializing services...');
        initializeSecretManager();
        await initializeHelixClient(config.twitch);
        await initializeChannelManager();

        // Get all active channels
        const activeChannels = await getActiveManagedChannels();
        console.log(`\n=== Verifying EventSub Subscriptions for ${activeChannels.length} Active Channels ===\n`);

        // Get all current subscriptions
        const subResult = await getEventSubSubscriptions();
        if (!subResult.success) {
            console.error('❌ Failed to fetch EventSub subscriptions');
            process.exit(1);
        }

        const allSubscriptions = subResult.data.data;

        // Build a map of broadcaster_user_id -> subscription types
        const subsByBroadcaster = new Map();
        allSubscriptions.forEach(sub => {
            const broadcasterId = sub.condition?.broadcaster_user_id || sub.condition?.to_broadcaster_user_id;
            if (broadcasterId) {
                if (!subsByBroadcaster.has(broadcasterId)) {
                    subsByBroadcaster.set(broadcasterId, new Set());
                }
                subsByBroadcaster.get(broadcasterId).add(sub.type);
            }
        });

        // Verify each active channel
        const issues = [];
        const healthy = [];

        for (const channelName of activeChannels) {
            // Get broadcaster ID
            const userData = await getUsersByLogin([channelName]);
            if (!userData || userData.length === 0) {
                issues.push({
                    channel: channelName,
                    error: 'Channel not found on Twitch',
                    severity: 'CRITICAL'
                });
                continue;
            }

            const broadcasterId = userData[0].id;
            const channelSubs = subsByBroadcaster.get(broadcasterId) || new Set();

            // Check for missing subscriptions
            const missing = REQUIRED_SUBSCRIPTION_TYPES.filter(type => !channelSubs.has(type));

            if (missing.length > 0) {
                const isCritical = missing.includes('stream.online');
                issues.push({
                    channel: channelName,
                    broadcasterId,
                    missing,
                    severity: isCritical ? 'CRITICAL' : 'WARNING'
                });
            } else {
                healthy.push({ channel: channelName, broadcasterId });
            }
        }

        // Print results
        console.log(`✅ Healthy channels: ${healthy.length}`);
        if (healthy.length > 0) {
            healthy.forEach(h => console.log(`   - ${h.channel}`));
        }

        console.log(`\n${issues.length > 0 ? '❌' : '✅'} Channels with issues: ${issues.length}`);

        if (issues.length > 0) {
            const critical = issues.filter(i => i.severity === 'CRITICAL');
            const warnings = issues.filter(i => i.severity === 'WARNING');

            if (critical.length > 0) {
                console.log(`\n🚨 CRITICAL Issues (${critical.length}):`);
                critical.forEach(issue => {
                    console.log(`\n   Channel: ${issue.channel}`);
                    if (issue.error) {
                        console.log(`   Error: ${issue.error}`);
                    } else {
                        console.log(`   Missing subscriptions: ${issue.missing.join(', ')}`);
                        if (issue.missing.includes('stream.online')) {
                            console.log(`   ⚠️  Missing stream.online - Stream notifications will not work!`);
                        }
                    }
                });
            }

            if (warnings.length > 0) {
                console.log(`\n⚠️  Warnings (${warnings.length}):`);
                warnings.forEach(issue => {
                    console.log(`\n   Channel: ${issue.channel}`);
                    console.log(`   Missing subscriptions: ${issue.missing.join(', ')}`);
                });
            }

            console.log('\n💡 To fix missing subscriptions, run:');
            console.log('   node scripts/manage-eventsub.js subscribe-all\n');

            process.exit(1);
        } else {
            console.log('\n✅ All channels have required EventSub subscriptions!\n');
            process.exit(0);
        }

    } catch (error) {
        logger.error({ err: error }, 'Error during verification');
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

verifyChannelSubscriptions();












