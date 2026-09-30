// tests/fixtures/fakeFirestore.js
// Minimal in-memory Firestore for tests that depend on transaction semantics
// (leases, claims, inbox consumption). Documents live in a flat Map keyed by
// path. Transactions run their callback against the live store, which is
// enough for sequential tests; contention is simulated by seeding documents.
// Sentinels from the real FieldValue (serverTimestamp, increment) are stored
// as a Date / applied, so tests can read them back.

function isServerTimestamp(value) {
    return value && typeof value === 'object' && value.constructor?.name === 'ServerTimestampTransform';
}

function normalize(value) {
    if (isServerTimestamp(value)) return new Date();
    return value;
}

function toComparable(value) {
    if (value instanceof Date) return value.getTime();
    if (value && typeof value.toMillis === 'function') return value.toMillis();
    return value;
}

function wrapTimestamps(data) {
    // Give Date fields a toMillis(), as Firestore Timestamps have.
    const out = {};
    for (const [k, v] of Object.entries(data)) {
        out[k] = v instanceof Date ? Object.assign(new Date(v.getTime()), { toMillis: () => v.getTime() }) : v;
    }
    return out;
}

function snapshot(path, data) {
    const id = path.split('/').pop();
    return {
        id,
        exists: data !== undefined,
        data: () => (data === undefined ? undefined : wrapTimestamps(data)),
        get: (field) => (data === undefined ? undefined : wrapTimestamps(data)[field]),
    };
}

export function createFakeFirestore() {
    const docs = new Map();
    const snapshotListeners = new Set();

    function notify() {
        for (const listener of snapshotListeners) listener();
    }

    function docRef(path) {
        const ref = {
            id: path.split('/').pop(),
            path,
            collection: (name) => collectionRef(`${path}/${name}`),
            get: async () => snapshot(path, docs.get(path)),
            set: async (data, opts) => {
                const base = opts?.merge ? (docs.get(path) || {}) : {};
                const next = { ...base };
                for (const [k, v] of Object.entries(data)) next[k] = normalize(v);
                docs.set(path, next);
                notify();
            },
            update: async (data) => {
                if (!docs.has(path)) throw Object.assign(new Error(`NOT_FOUND: ${path}`), { code: 5 });
                const next = { ...docs.get(path) };
                for (const [k, v] of Object.entries(data)) {
                    if (v && typeof v === 'object' && v.constructor?.name === 'NumericIncrementTransform') {
                        next[k] = (next[k] || 0) + v.operand;
                    } else {
                        next[k] = normalize(v);
                    }
                }
                docs.set(path, next);
                notify();
            },
            delete: async () => {
                docs.delete(path);
                notify();
            },
        };
        return ref;
    }

    function childDocs(path) {
        const prefix = `${path}/`;
        return [...docs.entries()]
            .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
            .map(([p, d]) => ({ path: p, data: d }));
    }

    function queryRef(path, filters = [], orderField = null) {
        const run = () => {
            let rows = childDocs(path);
            for (const { field, op, value } of filters) {
                rows = rows.filter(r => {
                    const a = toComparable(r.data[field]);
                    const b = toComparable(value);
                    if (op === '>') return a > b;
                    if (op === '==') return a === b;
                    throw new Error(`fake firestore: unsupported op ${op}`);
                });
            }
            if (orderField) {
                rows.sort((x, y) => toComparable(x.data[orderField]) - toComparable(y.data[orderField]));
            }
            return rows;
        };
        return {
            where: (field, op, value) => queryRef(path, [...filters, { field, op, value }], orderField),
            orderBy: (field) => queryRef(path, filters, field),
            count: () => ({ get: async () => ({ data: () => ({ count: run().length }) }) }),
            get: async () => {
                const rows = run();
                return {
                    size: rows.length,
                    docs: rows.map(r => ({ ...snapshot(r.path, r.data), ref: docRef(r.path) })),
                    forEach: (fn) => rows.forEach(r => fn({ ...snapshot(r.path, r.data), ref: docRef(r.path) })),
                };
            },
            onSnapshot: (onNext, onError) => {
                let seen = new Set();
                const listener = () => {
                    const rows = run();
                    const added = rows.filter(r => !seen.has(r.path));
                    seen = new Set(rows.map(r => r.path));
                    if (added.length === 0) return;
                    onNext({
                        docChanges: () => added.map(r => ({
                            type: 'added',
                            doc: { ...snapshot(r.path, r.data), ref: docRef(r.path) },
                        })),
                    });
                };
                listener.fail = (err) => {
                    snapshotListeners.delete(listener);
                    onError?.(err);
                };
                snapshotListeners.add(listener);
                // Initial snapshot, delivered asynchronously like the real client.
                Promise.resolve().then(listener);
                return () => snapshotListeners.delete(listener);
            },
        };
    }

    function collectionRef(path) {
        return {
            ...queryRef(path),
            doc: (id) => docRef(`${path}/${id}`),
        };
    }

    // Real Firestore transactions are serializable (conflicting ones retry), so
    // the fake runs them one at a time.
    let txQueue = Promise.resolve();

    const db = {
        collection: (name) => collectionRef(name),
        runTransaction: (fn) => {
            const run = txQueue.then(() => runOne(fn));
            txQueue = run.catch(() => {});
            return run;
        },
        // Test helpers
        _docs: docs,
        _seed: (path, data) => { docs.set(path, data); notify(); },
        _read: (path) => docs.get(path),
        // Kills every open listener the way a non-retryable stream error does.
        _failListeners: (err) => {
            for (const listener of [...snapshotListeners]) listener.fail?.(err);
        },
    };

    async function runOne(fn) {
        const writes = [];
        const tx = {
            get: (ref) => ref.get(),
            set: (ref, data, opts) => { writes.push(() => ref.set(data, opts)); },
            update: (ref, data) => { writes.push(() => ref.update(data)); },
            delete: (ref) => { writes.push(() => ref.delete()); },
        };
        const result = await fn(tx);
        for (const write of writes) await write();
        return result;
    }

    return db;
}
