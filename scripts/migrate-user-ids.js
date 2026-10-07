#!/usr/bin/env node

/**
 * scripts/migrate-user-ids.js
 *
 * One-time migration of chatter-scoped Firestore data from login names to Twitch user IDs (see
 * src/lib/userIdentity.js for why). Logins are resolved through Helix; channel logins through
 * managedChannels.
 *
 *   channelMemories/{id}/items/*   fills in `subjectIds` (in place)
 *   channelMemories/{id}           turns `optedOut` logins into `optedOutIds` (in place)
 *   {trivia,geo,riddle}PlayerStats moves {login} docs to {userId}, adding counters onto any doc the
 *                                  bot already wrote there and rekeying channels.<login> to
 *                                  channels.<broadcasterId>; the source is deleted in the same batch
 *   userTranslations               moves {channel}:{login} docs to {broadcasterId}:{userId}
 *
 * Every step skips data already in the new scheme, so the script can be re-run safely.
 *
 * Usage:
 *   node scripts/migrate-user-ids.js [--project <id>] [--apply] [--only a,b]
 *
 * Options:
 *   --project <id>   GCP project. Defaults to GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT.
 *   --apply          Write changes. Without it the script only reports what it would do.
 *   --only <names>   Comma-separated subset of: memories, triviaPlayerStats, geoPlayerStats,
 *                    riddlePlayerStats, userTranslations.
 *
 * Runbook:
 *   1. Dry run and read the UNRESOLVED list: logins Twitch no longer knows (renamed or deleted
 *      accounts). Those documents are left in place.
 *   2. Run with --apply, then deploy the bot that reads user IDs.
 *   3. Run with --apply again to sweep up anything old instances wrote during the rollout.
 */

import { Firestore, FieldValue } from '@google-cloud/firestore';
import { isBroadcasterIdKey, normalizeChannelName } from '../src/lib/channelKey.js';
import { initializeSecretManager } from '../src/lib/secretManager.js';
import { initializeHelixClient } from '../src/components/twitch/helixClient.js';
import { resolveUserIds } from '../src/lib/userIdentity.js';
import config from '../src/config/index.js';
import {
    BatchWriter,
    MIGRATION_TARGETS,
    migrateMemories,
    migratePlayerStats,
    migrateTranslations,
} from './lib/userIdMigration.js';

function parseArgs(argv) {
    const args = { apply: false, project: null, only: null };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--apply') args.apply = true;
        else if (arg === '--project') args.project = argv[++i];
        else if (arg === '--only') args.only = new Set(String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean));
        else if (arg === '--help' || arg === '-h') {
            console.log('Usage: node scripts/migrate-user-ids.js [--project <id>] [--apply] [--only a,b]');
            process.exit(0);
        } else {
            console.error(`Unknown argument: ${arg}`);
            process.exit(1);
        }
    }
    const unknown = [...(args.only || [])].filter(name => !MIGRATION_TARGETS.includes(name));
    if (unknown.length > 0) {
        console.error(`Unknown --only target(s): ${unknown.join(', ')}. Valid: ${MIGRATION_TARGETS.join(', ')}`);
        process.exit(1);
    }
    return args;
}

async function loadChannelIds(db) {
    const snapshot = await db.collection('managedChannels').get();
    const byLogin = new Map();
    snapshot.forEach(doc => {
        const data = doc.data() || {};
        const login = typeof data.channelName === 'string' ? normalizeChannelName(data.channelName) : null;
        const id = data.twitchUserId ? String(data.twitchUserId) : (isBroadcasterIdKey(doc.id) ? doc.id : null);
        if (login && id) byLogin.set(login, id);
    });
    return byLogin;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const projectId = args.project || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
    if (!projectId) {
        console.error('No project: pass --project or set GOOGLE_CLOUD_PROJECT.');
        process.exit(1);
    }

    initializeSecretManager();
    await initializeHelixClient(config.twitch);

    const db = new Firestore({ projectId });
    const channelIds = await loadChannelIds(db);
    const ctx = { resolveLogins: resolveUserIds, channelIds, FieldValue };
    const targets = MIGRATION_TARGETS.filter(name => !args.only || args.only.has(name));

    console.log(`${args.apply ? 'APPLYING' : 'DRY RUN'} against ${projectId}: ${targets.join(', ')}`);
    let unresolvedTotal = 0;
    for (const target of targets) {
        const writer = new BatchWriter(db, args.apply);
        let stats;
        if (target === 'memories') stats = await migrateMemories(db, writer, ctx);
        else if (target === 'userTranslations') stats = await migrateTranslations(db, writer, ctx);
        else stats = await migratePlayerStats(db, writer, target, ctx);
        await writer.flush();

        console.log(`\n${target}: scanned ${stats.scanned}, migrated ${stats.migrated}, already done ${stats.skipped}, writes ${writer.written}`);
        if (stats.unresolved.length > 0) {
            unresolvedTotal += stats.unresolved.length;
            console.log(`  UNRESOLVED (left in place):\n    ${stats.unresolved.join('\n    ')}`);
        }
    }
    if (!args.apply) console.log('\nDry run only. Re-run with --apply to write.');
    if (unresolvedTotal > 0) process.exitCode = 2;
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
