// src/components/quotes/quoteStorage.js
import { Firestore, FieldValue } from '@google-cloud/firestore';
import logger from '../../lib/logger.js';

const QUOTES_COLLECTION = 'quotes';
const QUOTE_COUNTERS_COLLECTION = 'quoteCounters';

let db = null;

export class QuoteStorageError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'QuoteStorageError';
        this.cause = cause;
    }
}

export async function initializeQuotesStorage() {
    logger.info("[QuoteStorage] Initializing Firestore client for quotes...");
    try {
        db = new Firestore();
        // Test access
        await db.collection(QUOTE_COUNTERS_COLLECTION).limit(1).get();
        logger.info("[QuoteStorage] Firestore initialized for quotes.");
    } catch (err) {
        logger.fatal({ err }, "[QuoteStorage] Failed to initialize Firestore.");
        throw err;
    }
}

function _getDb() {
    if (!db) throw new Error("[QuoteStorage] Not initialized. Call initializeQuotesStorage first.");
    return db;
}

function _channelKey(channelName) {
    return String(channelName || '').toLowerCase();
}

function _quoteDocId(channelName, quoteId) {
    return `${_channelKey(channelName)}-${quoteId}`;
}

export async function addQuote(channelName, text, saidBy, addedBy) {
    const database = _getDb();
    const chan = _channelKey(channelName);

    if (!text || !text.trim()) throw new QuoteStorageError('Quote text is required');

    return await database.runTransaction(async (tx) => {
        const counterRef = database.collection(QUOTE_COUNTERS_COLLECTION).doc(chan);
        const counterSnap = await tx.get(counterRef);

        let nextId = 1;
        if (counterSnap.exists && Number.isFinite(counterSnap.data().nextId)) {
            nextId = counterSnap.data().nextId;
        }

        const quoteId = nextId;
        const newNext = quoteId + 1;

        const quoteRef = database.collection(QUOTES_COLLECTION).doc(_quoteDocId(chan, quoteId));
        tx.set(quoteRef, {
            channel: chan,
            quoteId,
            text: String(text).trim(),
            saidBy: saidBy ? String(saidBy).trim() : null,
            addedBy: addedBy ? String(addedBy).trim() : null,
            createdAt: FieldValue.serverTimestamp(),
            lastShownAt: null,
            usageCount: 0
        });

        tx.set(counterRef, { nextId: newNext }, { merge: true });

        return { quoteId };
    });
}

export async function getQuoteById(channelName, quoteId) {
    const database = _getDb();
    const chan = _channelKey(channelName);
    const ref = database.collection(QUOTES_COLLECTION).doc(_quoteDocId(chan, quoteId));
    const snap = await ref.get();
    return snap.exists ? snap.data() : null;
}

export async function getRandomQuote(channelName) {
    const database = _getDb();
    const chan = _channelKey(channelName);

    try {
        // Fetch all quotes for true randomness (or a large sample)
        const snap = await database.collection(QUOTES_COLLECTION)
            .where('channel', '==', chan)
            .orderBy('createdAt', 'desc')
            .limit(500)
            .get();

        const docs = snap.docs.map(d => d.data());
        if (docs.length === 0) return null;
        
        // Shuffle array for true randomness
        for (let i = docs.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [docs[i], docs[j]] = [docs[j], docs[i]];
        }
        return docs[0];
    } catch (error) {
        // If index doesn't exist yet, try without orderBy as fallback
        if (error?.code === 9 || error?.message?.includes('index')) {
            logger.warn({ channel: chan, err: error }, '[QuoteStorage] Index missing, falling back to simple query');
            const snap = await database.collection(QUOTES_COLLECTION)
                .where('channel', '==', chan)
                .limit(500)
                .get();
            const docs = snap.docs.map(d => d.data());
            if (docs.length === 0) return null;
            
            // Shuffle array for true randomness even in fallback
            for (let i = docs.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [docs[i], docs[j]] = [docs[j], docs[i]];
            }
            return docs[0];
        }
        throw error;
    }
}

export async function getLastQuote(channelName) {
    const database = _getDb();
    const chan = _channelKey(channelName);
    
    try {
        const snap = await database.collection(QUOTES_COLLECTION)
            .where('channel', '==', chan)
            .orderBy('createdAt', 'desc')
            .limit(1)
            .get();

        if (snap.empty) return null;
        return snap.docs[0].data();
    } catch (error) {
        // If index doesn't exist yet, try without orderBy as fallback
        if (error?.code === 9 || error?.message?.includes('index')) {
            logger.warn({ channel: chan, err: error }, '[QuoteStorage] Index missing, falling back to simple query');
            const snap = await database.collection(QUOTES_COLLECTION)
                .where('channel', '==', chan)
                .limit(1)
                .get();
            if (snap.empty) return null;
            // Without orderBy, we can't guarantee it's the "last" one, but return what we get
            return snap.docs[0].data();
        }
        throw error;
    }
}

export async function searchQuotes(channelName, term) {
    const database = _getDb();
    const chan = _channelKey(channelName);
    const q = String(term || '').toLowerCase();

    try {
        // Firestore doesn't support substring contains well; fetch a window and filter client-side.
        const snap = await database.collection(QUOTES_COLLECTION)
            .where('channel', '==', chan)
            .orderBy('createdAt', 'desc')
            .limit(100)
            .get();

        const results = [];
        for (const doc of snap.docs) {
            const data = doc.data();
            if (String(data.text || '').toLowerCase().includes(q) ||
                String(data.saidBy || '').toLowerCase().includes(q)) {
                results.push(data);
            }
        }
        return results;
    } catch (error) {
        // If index doesn't exist yet, try without orderBy as fallback
        if (error?.code === 9 || error?.message?.includes('index')) {
            logger.warn({ channel: chan, err: error }, '[QuoteStorage] Index missing, falling back to simple query');
            const snap = await database.collection(QUOTES_COLLECTION)
                .where('channel', '==', chan)
                .limit(100)
                .get();
            const results = [];
            for (const doc of snap.docs) {
                const data = doc.data();
                if (String(data.text || '').toLowerCase().includes(q) ||
                    String(data.saidBy || '').toLowerCase().includes(q)) {
                    results.push(data);
                }
            }
            return results;
        }
        throw error;
    }
}

export async function deleteQuote(channelName, quoteId) {
    const database = _getDb();
    const chan = _channelKey(channelName);
    const ref = database.collection(QUOTES_COLLECTION).doc(_quoteDocId(chan, quoteId));
    const snap = await ref.get();
    if (!snap.exists) return false;
    await ref.delete();
    return true;
}

export async function editQuote(channelName, quoteId, newText, newSaidBy = null) {
    const database = _getDb();
    const chan = _channelKey(channelName);
    const ref = database.collection(QUOTES_COLLECTION).doc(_quoteDocId(chan, quoteId));
    const snap = await ref.get();
    if (!snap.exists) return false;

    const update = {
        lastEditedAt: FieldValue.serverTimestamp()
    };
    if (newText && newText.trim()) update.text = newText.trim();
    if (newSaidBy !== undefined) update.saidBy = newSaidBy ? String(newSaidBy).trim() : null;

    await ref.update(update);
    return true;
}