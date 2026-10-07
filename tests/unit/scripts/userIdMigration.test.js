// tests/unit/scripts/userIdMigration.test.js

import {
    BatchWriter,
    migrateMemories,
    migratePlayerStats,
    migrateTranslations,
} from '../../../scripts/lib/userIdMigration.js';

// Minimal in-memory Firestore: enough of the API for the migration, with write sentinels applied.
const FieldValue = {
    increment: n => ({ __inc: n }),
    arrayUnion: (...values) => ({ __union: values }),
    delete: () => ({ __del: true }),
};

function applyMerge(existing, update) {
    const out = { ...existing };
    for (const [key, value] of Object.entries(update)) {
        if (value?.__del) delete out[key];
        else if (typeof value?.__inc === 'number') out[key] = (out[key] || 0) + value.__inc;
        else if (value?.__union) out[key] = [...new Set([...(out[key] || []), ...value.__union])];
        else if (value && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value)) out[key] = applyMerge(out[key] || {}, value);
        else out[key] = value;
    }
    return out;
}

function fakeDb(initial) {
    const store = new Map(Object.entries(initial));
    const docRef = (path) => ({
        id: path.split('/').pop(),
        path,
        get: async () => ({ exists: store.has(path), data: () => store.get(path) }),
        collection: name => collectionRef(`${path}/${name}`),
    });
    const collectionRef = (path) => ({
        doc: id => docRef(`${path}/${id}`),
        get: async () => {
            const depth = path.split('/').length + 1;
            const docs = [...store.keys()]
                .filter(key => key.startsWith(`${path}/`) && key.split('/').length === depth)
                .map(key => ({ id: key.split('/').pop(), ref: docRef(key), data: () => store.get(key) }));
            return { docs, forEach: fn => docs.forEach(fn) };
        },
    });
    return {
        store,
        collection: collectionRef,
        batch: () => {
            const ops = [];
            return {
                set: (ref, data, options) => ops.push(() => store.set(ref.path, options?.merge ? applyMerge(store.get(ref.path) || {}, data) : applyMerge({}, data))),
                delete: ref => ops.push(() => store.delete(ref.path)),
                commit: async () => ops.forEach(op => op()),
            };
        },
    };
}

const USERS = { sleepysabrinas: '33', bob: '22', amy: '55' };
const ctx = {
    resolveLogins: async logins => new Map(logins.map(l => String(l).toLowerCase()).filter(l => USERS[l]).map(l => [l, USERS[l]])),
    channelIds: new Map([['parfaitfair', '129295549']]),
    FieldValue,
};

async function run(fn, db, ...args) {
    const writer = new BatchWriter(db, true);
    const stats = await fn(db, writer, ...args);
    await writer.flush();
    return stats;
}

describe('migratePlayerStats', () => {
    const legacyBob = {
        globalPoints: 10, globalSuccesses: 2, displayName: 'Bob',
        channels: { parfaitfair: { points: 10, successes: 2, lastSuccessTimestamp: new Date('2026-09-01') } },
    };

    it('moves a login doc to the user ID, rekeys channels and adds onto counters the bot already wrote', async () => {
        const db = fakeDb({
            'triviaPlayerStats/bob': legacyBob,
            'triviaPlayerStats/22': {
                login: 'bob', globalPoints: 3, globalSuccesses: 1,
                channels: { 129295549: { points: 3, successes: 1, lastSuccessTimestamp: new Date('2026-10-05') } },
            },
        });
        const stats = await run(migratePlayerStats, db, 'triviaPlayerStats', ctx);

        expect(stats).toMatchObject({ migrated: 1, skipped: 1, unresolved: [] });
        expect(db.store.has('triviaPlayerStats/bob')).toBe(false);
        expect(db.store.get('triviaPlayerStats/22')).toEqual({
            login: 'bob', displayName: 'Bob', globalPoints: 13, globalSuccesses: 3,
            channels: { 129295549: { points: 13, successes: 3, lastSuccessTimestamp: new Date('2026-10-05') } },
        });
    });

    it('never double-counts when run again', async () => {
        const db = fakeDb({ 'geoPlayerStats/bob': legacyBob });
        await run(migratePlayerStats, db, 'geoPlayerStats', ctx);
        const second = await run(migratePlayerStats, db, 'geoPlayerStats', ctx);

        expect(second).toMatchObject({ migrated: 0, skipped: 1 });
        expect(db.store.get('geoPlayerStats/22').globalPoints).toBe(10);
    });

    it('leaves docs it cannot resolve in place and reports them', async () => {
        const db = fakeDb({
            'riddlePlayerStats/ghost': { globalPoints: 1 },
            'riddlePlayerStats/amy': { globalPoints: 1, channels: { gonechannel: { points: 1 } } },
        });
        const stats = await run(migratePlayerStats, db, 'riddlePlayerStats', ctx);

        expect(stats.unresolved).toEqual(['ghost', 'amy (channels: gonechannel)']);
        expect(db.store.has('riddlePlayerStats/ghost')).toBe(true);
        expect(db.store.has('riddlePlayerStats/amy')).toBe(true);
    });

    it('writes nothing on a dry run', async () => {
        const db = fakeDb({ 'triviaPlayerStats/bob': legacyBob });
        const writer = new BatchWriter(db, false);
        await migratePlayerStats(db, writer, 'triviaPlayerStats', ctx);

        expect(writer.written).toBe(2);
        expect(db.store.has('triviaPlayerStats/bob')).toBe(true);
    });
});

describe('migrateTranslations', () => {
    it('moves channel:login docs to broadcasterId:userId', async () => {
        const db = fakeDb({
            'userTranslations/parfaitfair:bob': { channelName: 'parfaitfair', username: 'bob', targetLanguage: 'spanish' },
            'userTranslations/parfaitfair:ghost': { targetLanguage: 'french' },
            'userTranslations/129295549:55': { userId: '55', targetLanguage: 'german' },
        });
        const stats = await run(migrateTranslations, db, ctx);

        expect(stats).toMatchObject({ migrated: 1, skipped: 1, unresolved: ['parfaitfair:ghost'] });
        expect(db.store.has('userTranslations/parfaitfair:bob')).toBe(false);
        expect(db.store.get('userTranslations/129295549:22')).toMatchObject({
            channelName: 'parfaitfair', userId: '22', login: 'bob', targetLanguage: 'spanish',
        });
    });
});

describe('migrateMemories', () => {
    it('fills subjectIds and converts opt-outs in place, skipping memories already done', async () => {
        const db = fakeDb({
            'channelMemories/129295549': { channelName: 'parfaitfair', optedOut: ['amy'] },
            'channelMemories/129295549/items/m1': { text: 'sleepysabrinas cannot have tree nuts.', subjects: ['sleepysabrinas'] },
            'channelMemories/129295549/items/m2': { text: 'Ghost lore.', subjects: ['ghost'] },
            'channelMemories/129295549/items/m3': { text: 'Done.', subjects: ['bob'], subjectIds: { 22: 'bob' } },
        });
        const stats = await run(migrateMemories, db, ctx);

        expect(stats).toMatchObject({ scanned: 3, migrated: 2, skipped: 1 });
        expect(stats.unresolved).toEqual(['129295549/m2 subject: ghost']);
        expect(db.store.get('channelMemories/129295549/items/m1').subjectIds).toEqual({ 33: 'sleepysabrinas' });
        expect(db.store.get('channelMemories/129295549/items/m2').subjectIds).toEqual({});
        expect(db.store.get('channelMemories/129295549')).toEqual({ channelName: 'parfaitfair', optedOutIds: ['55'] });
    });

    it('keeps an opt-out it cannot resolve rather than dropping it', async () => {
        const db = fakeDb({ 'channelMemories/1': { optedOut: ['amy', 'ghost'] } });
        const stats = await run(migrateMemories, db, ctx);

        expect(stats.unresolved).toEqual(['1 opt-out: ghost']);
        expect(db.store.get('channelMemories/1')).toEqual({ optedOut: ['amy', 'ghost'] });
    });
});
