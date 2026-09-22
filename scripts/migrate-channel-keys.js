#!/usr/bin/env node

/**
 * scripts/migrate-channel-keys.js
 *
 * One-time migration of channel-scoped Firestore documents from login-name
 * keys to broadcaster-ID keys (see src/lib/channelKey.js for why).
 *
 * For every login-keyed document in the collections below, the script looks up
 * the broadcaster ID in managedChannels and copies the document — and its
 * subcollections — to a document keyed by that ID. Existing data under the ID
 * key always wins: a field or subcollection document that is already there is
 * left untouched, so the script is idempotent and safe to run before or after
 * the bot and web UI switch over. The login-keyed originals are kept unless
 * --delete-old is given, so a bad run can be inspected and re-run.
 *
 * Usage:
 *   node scripts/migrate-channel-keys.js [--project <id>] [--apply] [--delete-old] [--only a,b]
 *
 * Options:
 *   --project <id>   GCP project. Defaults to GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT.
 *   --apply          Write changes. Without it the script only reports what it would do.
 *   --delete-old     After a successful copy, delete the login-keyed original (needs --apply).
 *   --only <names>   Comma-separated subset of the collections listed in COLLECTIONS.
 *
 * Runbook:
 *   1. Dry run and read the report, especially the "unresolved" list: those are
 *      logins with no managedChannels document carrying a twitchUserId. Fix the
 *      channel document (scripts/add-streamer.js) or accept that the data is
 *      orphaned before going further.
 *   2. Run with --apply. Deploy the bot and the web UI that read ID keys.
 *   3. Run with --apply again to catch anything written to login keys between
 *      steps 2 and the deploy landing.
 *   4. Once the bot has been observed reading the migrated data, run with
 *      --apply --delete-old.
 */

import { Firestore } from '@google-cloud/firestore';

const COLLECTIONS = [
    { name: 'channelMemories', subcollections: ['items'] },
    { name: 'channelMemoryPending', subcollections: [] },
    { name: 'channelQuotes', subcollections: ['items'] },
    { name: 'channelTimers', subcollections: ['timers'] },
    { name: 'customCommands', subcollections: ['commands', 'checkinConfig', 'checkinCounters'] },
    { name: 'channelCommands', subcollections: [] },
    { name: 'autoChatConfigs', subcollections: [] },
    { name: 'channelLanguages', subcollections: [] },
    { name: 'triviaGameConfigs', subcollections: [] },
    { name: 'geoGameConfigs', subcollections: [] },
    { name: 'riddleGameConfigs', subcollections: [] },
];

const MANAGED_CHANNELS_COLLECTION = 'managedChannels';
const BATCH_LIMIT = 400;

function parseArgs(argv) {
    const args = { apply: false, deleteOld: false, project: null, only: null };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--apply') args.apply = true;
        else if (arg === '--delete-old') args.deleteOld = true;
        else if (arg === '--project') args.project = argv[++i];
        else if (arg === '--only') args.only = new Set(String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean));
        else if (arg === '--help' || arg === '-h') {
            console.log('Usage: node scripts/migrate-channel-keys.js [--project <id>] [--apply] [--delete-old] [--only a,b]');
            process.exit(0);
        } else {
            console.error(`Unknown argument: ${arg}`);
            process.exit(1);
        }
    }
    if (args.deleteOld && !args.apply) {
        console.error('--delete-old requires --apply');
        process.exit(1);
    }
    return args;
}

function isBroadcasterIdKey(docId) {
    return /^\d+$/.test(docId);
}

/**
 * login (lowercase) → broadcaster ID, from managedChannels. Documents without a
 * twitchUserId are reported so the operator can repair them first.
 */
async function loadChannelMap(db) {
    const snapshot = await db.collection(MANAGED_CHANNELS_COLLECTION).get();
    const byLogin = new Map();
    const missingId = [];
    snapshot.forEach(doc => {
        const data = doc.data() || {};
        const login = typeof data.channelName === 'string' ? data.channelName.trim().toLowerCase() : null;
        const id = data.twitchUserId ? String(data.twitchUserId) : (isBroadcasterIdKey(doc.id) ? doc.id : null);
        if (!login) return;
        if (!id) {
            missingId.push(login);
            return;
        }
        byLogin.set(login, id);
    });
    return { byLogin, missingId };
}

class BatchWriter {
    constructor(db, apply) {
        this.db = db;
        this.apply = apply;
        this.batch = null;
        this.pending = 0;
        this.written = 0;
    }

    _ensure() {
        if (!this.batch) this.batch = this.db.batch();
    }

    async set(ref, data, options) {
        if (!this.apply) { this.written++; return; }
        this._ensure();
        this.batch.set(ref, data, options);
        await this._tick();
    }

    async delete(ref) {
        if (!this.apply) { this.written++; return; }
        this._ensure();
        this.batch.delete(ref);
        await this._tick();
    }

    async _tick() {
        this.pending++;
        this.written++;
        if (this.pending >= BATCH_LIMIT) await this.flush();
    }

    async flush() {
        if (this.batch && this.pending > 0) {
            await this.batch.commit();
        }
        this.batch = null;
        this.pending = 0;
    }
}

/**
 * Copies one login-keyed document (plus listed subcollections) to its ID key.
 * Never overwrites what is already under the ID key.
 */
async function migrateDocument(db, writer, spec, sourceRef, targetId, login, stats) {
    const targetRef = db.collection(spec.name).doc(targetId);
    const [sourceSnap, targetSnap] = await Promise.all([sourceRef.get(), targetRef.get()]);

    if (sourceSnap.exists) {
        const sourceData = sourceSnap.data() || {};
        const targetData = targetSnap.exists ? (targetSnap.data() || {}) : {};
        const toWrite = {};
        for (const [key, value] of Object.entries(sourceData)) {
            if (!(key in targetData)) toWrite[key] = value;
        }
        if (!('channelName' in targetData)) toWrite.channelName = login;
        if (Object.keys(toWrite).length > 0) {
            await writer.set(targetRef, toWrite, { merge: true });
            stats.parentWrites++;
        } else {
            stats.parentSkipped++;
        }
    } else if (!targetSnap.exists) {
        // A "missing" parent whose subcollections hold data: give the target a
        // real document so listing loaders can see it.
        await writer.set(targetRef, { channelName: login }, { merge: true });
        stats.parentWrites++;
    }

    for (const sub of spec.subcollections) {
        const sourceItems = await sourceRef.collection(sub).get();
        if (sourceItems.empty) continue;
        const targetCol = targetRef.collection(sub);
        const existing = new Set((await targetCol.listDocuments()).map(ref => ref.id));
        for (const item of sourceItems.docs) {
            if (existing.has(item.id)) {
                stats.itemsSkipped++;
                continue;
            }
            await writer.set(targetCol.doc(item.id), item.data());
            stats.itemsCopied++;
        }
    }
}

async function deleteDocument(db, writer, spec, sourceRef, stats) {
    for (const sub of spec.subcollections) {
        const refs = await sourceRef.collection(sub).listDocuments();
        for (const ref of refs) {
            await writer.delete(ref);
            stats.itemsDeleted++;
        }
    }
    await writer.delete(sourceRef);
    stats.parentsDeleted++;
}

async function migrateCollection(db, writer, spec, byLogin, args) {
    const stats = {
        collection: spec.name,
        alreadyKeyedById: 0,
        migrated: [],
        unresolved: [],
        parentWrites: 0,
        parentSkipped: 0,
        itemsCopied: 0,
        itemsSkipped: 0,
        parentsDeleted: 0,
        itemsDeleted: 0,
    };

    // listDocuments() includes "missing" parents that only exist because a
    // subcollection under them has data; get() would not.
    const refs = await db.collection(spec.name).listDocuments();
    for (const ref of refs) {
        if (isBroadcasterIdKey(ref.id)) {
            stats.alreadyKeyedById++;
            continue;
        }
        const login = ref.id.toLowerCase();
        const targetId = byLogin.get(login);
        if (!targetId) {
            stats.unresolved.push(login);
            continue;
        }
        await migrateDocument(db, writer, spec, ref, targetId, login, stats);
        stats.migrated.push(`${login} -> ${targetId}`);
        if (args.deleteOld) {
            await deleteDocument(db, writer, spec, ref, stats);
        }
    }
    await writer.flush();
    return stats;
}

function report(stats, args) {
    const mode = args.apply ? 'APPLIED' : 'DRY RUN';
    console.log(`\n[${mode}] ${stats.collection}`);
    console.log(`  already keyed by ID : ${stats.alreadyKeyedById}`);
    console.log(`  migrated            : ${stats.migrated.length}`);
    for (const line of stats.migrated) console.log(`    ${line}`);
    console.log(`  parent writes       : ${stats.parentWrites} (skipped ${stats.parentSkipped}, target already complete)`);
    console.log(`  items copied        : ${stats.itemsCopied} (skipped ${stats.itemsSkipped}, already present)`);
    if (args.deleteOld) {
        console.log(`  originals deleted   : ${stats.parentsDeleted} parents, ${stats.itemsDeleted} items`);
    }
    if (stats.unresolved.length > 0) {
        console.log(`  UNRESOLVED (no broadcaster ID in managedChannels; left in place):`);
        for (const login of stats.unresolved) console.log(`    ${login}`);
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const projectId = args.project || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
    if (!projectId) {
        console.error('No project: pass --project <id> or set GOOGLE_CLOUD_PROJECT');
        process.exit(1);
    }

    const db = new Firestore({ projectId });
    console.log(`Project: ${projectId}`);
    console.log(`Mode: ${args.apply ? 'apply' : 'dry run'}${args.deleteOld ? ' + delete originals' : ''}`);

    const { byLogin, missingId } = await loadChannelMap(db);
    console.log(`managedChannels: ${byLogin.size} channels with a broadcaster ID`);
    if (missingId.length > 0) {
        console.log(`managedChannels documents WITHOUT twitchUserId (their data cannot be migrated): ${missingId.join(', ')}`);
    }

    const specs = COLLECTIONS.filter(spec => !args.only || args.only.has(spec.name));
    if (specs.length === 0) {
        console.error('No collections selected');
        process.exit(1);
    }

    const writer = new BatchWriter(db, args.apply);
    let unresolvedTotal = 0;
    for (const spec of specs) {
        const stats = await migrateCollection(db, writer, spec, byLogin, args);
        report(stats, args);
        unresolvedTotal += stats.unresolved.length;
    }

    console.log(`\nTotal writes ${args.apply ? 'committed' : 'that would be made'}: ${writer.written}`);
    if (unresolvedTotal > 0) {
        console.log(`${unresolvedTotal} login-keyed document(s) could not be resolved and were left in place.`);
        process.exitCode = 2;
    }
}

main().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
