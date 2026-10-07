// scripts/lib/userIdMigration.js
//
// The logic behind scripts/migrate-user-ids.js, kept apart from the CLI so it can be tested
// against a fake Firestore. Every step is idempotent: documents already in the user-ID scheme are
// skipped, and moved documents are deleted in the same batch that writes their replacement, so
// running the migration again never counts anything twice.

const BATCH_LIMIT = 400;
const PLAYER_STATS_COLLECTIONS = ['triviaPlayerStats', 'geoPlayerStats', 'riddlePlayerStats'];
const TRANSLATIONS_COLLECTION = 'userTranslations';
const MEMORY_COLLECTION = 'channelMemories';
const MEMORY_ITEMS = 'items';

export const MIGRATION_TARGETS = ['memories', ...PLAYER_STATS_COLLECTIONS, TRANSLATIONS_COLLECTION];

export class BatchWriter {
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
        this.written++;
        if (!this.apply) return;
        this._ensure();
        this.batch.set(ref, data, options);
        await this._tick();
    }

    async delete(ref) {
        this.written++;
        if (!this.apply) return;
        this._ensure();
        this.batch.delete(ref);
        await this._tick();
    }

    async _tick() {
        this.pending++;
        if (this.pending >= BATCH_LIMIT) await this.flush();
    }

    async flush() {
        if (this.batch && this.pending > 0) await this.batch.commit();
        this.batch = null;
        this.pending = 0;
    }
}

function newStats() {
    return { scanned: 0, migrated: 0, skipped: 0, unresolved: [] };
}

function toMillis(value) {
    if (!value) return 0;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (value instanceof Date) return value.getTime();
    return new Date(value).getTime() || 0;
}

const isTimestamp = value => value instanceof Date || typeof value?.toMillis === 'function';

/**
 * Builds a merge-set that adds a legacy stats map onto whatever the target already holds:
 * numbers become increments, timestamps keep the later one, anything else only fills a gap.
 */
function mergeStatsFields(source, target, FieldValue) {
    const out = {};
    for (const [field, value] of Object.entries(source || {})) {
        if (typeof value === 'number') {
            out[field] = FieldValue.increment(value);
        } else if (isTimestamp(value)) {
            if (toMillis(value) > toMillis(target?.[field])) out[field] = value;
        } else if (value !== undefined && value !== null && target?.[field] === undefined) {
            out[field] = value;
        }
    }
    return out;
}

/**
 * Moves login-keyed player stats docs to user-ID docs, rekeying `channels.<login>` to
 * `channels.<broadcasterId>`. A doc written by the new code carries `login`; one without it is legacy.
 */
export async function migratePlayerStats(db, writer, collectionName, { resolveLogins, channelIds, FieldValue }) {
    const stats = newStats();
    const snapshot = await db.collection(collectionName).get();
    const legacy = snapshot.docs.filter(doc => !doc.data()?.login);
    stats.scanned = snapshot.docs.length;
    stats.skipped = stats.scanned - legacy.length;
    const ids = await resolveLogins(legacy.map(doc => doc.id));

    for (const doc of legacy) {
        const login = doc.id.toLowerCase();
        const userId = ids.get(login);
        const data = doc.data() || {};
        const channelKeys = Object.keys(data.channels || {});
        const unknownChannels = channelKeys.filter(channel => !channelIds.has(channel.toLowerCase()));
        if (!userId || unknownChannels.length > 0) {
            stats.unresolved.push(userId ? `${login} (channels: ${unknownChannels.join(', ')})` : login);
            continue;
        }

        const targetRef = db.collection(collectionName).doc(userId);
        const targetSnap = await targetRef.get();
        const target = targetSnap.exists ? targetSnap.data() : {};

        const { channels, ...topLevel } = data;
        const update = { ...mergeStatsFields(topLevel, target, FieldValue), login };
        if (channelKeys.length > 0) {
            update.channels = {};
            for (const channel of channelKeys) {
                const broadcasterId = channelIds.get(channel.toLowerCase());
                update.channels[broadcasterId] = mergeStatsFields(channels[channel], target.channels?.[broadcasterId], FieldValue);
            }
        }
        await writer.set(targetRef, update, { merge: true });
        await writer.delete(doc.ref);
        stats.migrated++;
    }
    return stats;
}

/** Moves `${channelLogin}:${login}` translation docs to `${broadcasterId}:${userId}`. */
export async function migrateTranslations(db, writer, { resolveLogins, channelIds }) {
    const stats = newStats();
    const snapshot = await db.collection(TRANSLATIONS_COLLECTION).get();
    stats.scanned = snapshot.docs.length;
    const legacy = snapshot.docs.filter(doc => !/^\d+:\d+$/.test(doc.id));
    stats.skipped = stats.scanned - legacy.length;

    const parsed = legacy.map(doc => {
        const [channel, ...rest] = doc.id.split(':');
        return { doc, channel: channel.toLowerCase(), login: rest.join(':').toLowerCase() };
    });
    const ids = await resolveLogins(parsed.map(entry => entry.login));

    for (const { doc, channel, login } of parsed) {
        const userId = ids.get(login);
        const broadcasterId = channelIds.get(channel);
        if (!userId || !broadcasterId) {
            stats.unresolved.push(doc.id);
            continue;
        }
        const data = doc.data() || {};
        await writer.set(db.collection(TRANSLATIONS_COLLECTION).doc(`${broadcasterId}:${userId}`), {
            channelName: channel,
            userId,
            login,
            targetLanguage: data.targetLanguage,
            updatedAt: data.updatedAt || new Date(),
        });
        await writer.delete(doc.ref);
        stats.migrated++;
    }
    return stats;
}

/**
 * Fills in `subjectIds` on memories and turns the login opt-out list into `optedOutIds`, in place
 * (memory docs are already keyed by broadcaster ID).
 */
export async function migrateMemories(db, writer, { resolveLogins, FieldValue }) {
    const stats = newStats();
    const channels = await db.collection(MEMORY_COLLECTION).get();
    for (const channelDoc of channels.docs) {
        const parent = channelDoc.data() || {};
        const optedOut = Array.isArray(parent.optedOut) ? parent.optedOut : [];
        if (optedOut.length > 0) {
            const ids = await resolveLogins(optedOut);
            const missing = optedOut.filter(login => !ids.has(String(login).toLowerCase()));
            // An opt-out that can't be carried over must not be dropped silently.
            if (missing.length > 0) {
                stats.unresolved.push(...missing.map(login => `${channelDoc.id} opt-out: ${login}`));
            } else {
                await writer.set(channelDoc.ref, {
                    optedOutIds: FieldValue.arrayUnion(...ids.values()),
                    optedOut: FieldValue.delete(),
                }, { merge: true });
            }
        }

        const items = await channelDoc.ref.collection(MEMORY_ITEMS).get();
        for (const item of items.docs) {
            stats.scanned++;
            const data = item.data() || {};
            const subjects = Array.isArray(data.subjects) ? data.subjects : [];
            if (data.subjectIds && typeof data.subjectIds === 'object') {
                stats.skipped++;
                continue;
            }
            const ids = await resolveLogins(subjects);
            const subjectIds = {};
            for (const login of subjects) {
                const id = ids.get(String(login).toLowerCase());
                if (id) subjectIds[id] = String(login).toLowerCase();
                else stats.unresolved.push(`${channelDoc.id}/${item.id} subject: ${login}`);
            }
            await writer.set(item.ref, { subjectIds }, { merge: true });
            stats.migrated++;
        }
    }
    return stats;
}
