// src/lib/geminiEmoteDescriber.js
// Uses Google Gemini Flash Lite to describe Twitch emotes visually for LLM context enrichment.
// Works directly with EventSub message fragments — no IRC conversion needed.
import { GoogleGenAI } from '@google/genai';
import { getFirestore, FieldValue } from './firestore.js';
import config from '../config/index.js';
import logger from './logger.js';

const { geminiModel, cdnUrl, timeoutMs } = config.emote;
const EMOTE_IMAGE_FORMAT = 'static/dark/3.0';

// System instruction applied to all emote description calls.
// Establishes accessibility framing and guards against common model failures.
const SYSTEM_INSTRUCTION = `You are an accessibility assistant that describes Twitch emotes for text-to-speech. Your goal is precise, natural-sounding visual descriptions.

Rules:
- Reply with ONLY the short description — no preamble, no quotes, no trailing punctuation.
- Do not output the emote's raw alphanumeric string verbatim (e.g. do not say "parfai14Parfait" or "LUL"). You may use meaningful English words embedded in the name (e.g. "parfait dessert" from "parfai14Parfait" is fine), but do not begin your reply with the full emote token itself.
- When describing pride flags, always name the specific flag rather than generic terms. Examples: "rainbow Pride flag", "bisexual Pride flag", "transgender Pride flag", "lesbian Pride flag", "pansexual Pride flag", "nonbinary Pride flag", "asexual Pride flag". These are important cultural identifiers and accurate naming is essential for accessibility.`;

// ---------------------------------------------------------------------------
// L1 in-memory cache: emoteId -> { description, cachedAt }
// ---------------------------------------------------------------------------
const descriptionCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// L2 Firestore persistent cache
// ---------------------------------------------------------------------------
const EMOTE_DESCRIPTIONS_COLLECTION = 'emoteDescriptions';
let emoteDescriptionsDb = null;

let genAI = null;

/**
 * Initialize the Gemini client for emote descriptions.
 * Call once during bot startup if GEMINI_API_KEY is available.
 * @param {string} apiKey - The Gemini API key
 * @returns {boolean} Whether initialization succeeded
 */
export function initEmoteDescriber(apiKey) {
    if (!apiKey) {
        logger.warn('GEMINI_API_KEY not set — emote description feature disabled');
        return false;
    }
    try {
        genAI = new GoogleGenAI({ apiKey });
        logger.info('Gemini emote describer initialized (model: %s)', geminiModel);
        return true;
    } catch (error) {
        logger.error({ err: error }, 'Failed to initialize Gemini emote describer');
        return false;
    }
}

/**
 * Initialize the Firestore reference for persistent emote description storage (L2 cache).
 * Uses the shared Firestore instance from lib/firestore.js.
 * Call once during bot startup (after initializeFirestore).
 * @returns {boolean}
 */
export function initEmoteDescriptionStore() {
    try {
        emoteDescriptionsDb = getFirestore();
        logger.info('Emote description Firestore store initialized');
        return true;
    } catch (error) {
        logger.error({ err: error }, 'Failed to initialize emote description Firestore store');
        return false;
    }
}

/**
 * Check if the emote describer is available.
 * @returns {boolean}
 */
export function isEmoteDescriberAvailable() {
    return genAI !== null;
}

/**
 * Extract unique emotes from EventSub message fragments.
 * @param {Array<{type: string, text: string, emote?: {id: string, owner_id?: string, format?: string[]}}>} fragments
 * @returns {Array<{id: string, name: string, count: number}>} Deduplicated emote entries
 */
export function extractEmotesFromFragments(fragments) {
    if (!Array.isArray(fragments) || fragments.length === 0) return [];

    const emoteCounts = new Map(); // emoteId -> { name, count }

    for (const frag of fragments) {
        if (frag.type !== 'emote' || !frag.emote?.id) continue;

        const id = frag.emote.id;
        const existing = emoteCounts.get(id);
        if (existing) {
            existing.count++;
        } else {
            emoteCounts.set(id, { name: frag.text, count: 1 });
        }
    }

    return Array.from(emoteCounts.entries()).map(([id, { name, count }]) => ({
        id,
        name,
        count,
    }));
}

/**
 * Get the static emote image URL from a Twitch emote ID.
 * @param {string} emoteId
 * @returns {string}
 */
export function getEmoteImageUrl(emoteId) {
    return `${cdnUrl}/${emoteId}/${EMOTE_IMAGE_FORMAT}`;
}

/**
 * Fetch an emote image as bytes (static PNG).
 * @param {string} emoteId
 * @returns {Promise<{data: Buffer, mimeType: string} | null>}
 */
async function fetchEmoteImage(emoteId) {
    try {
        const url = getEmoteImageUrl(emoteId);
        const response = await fetch(url);
        if (!response.ok) {
            logger.debug({ emoteId, status: response.status }, 'Failed to fetch emote image');
            return null;
        }
        const arrayBuffer = await response.arrayBuffer();
        const contentType = response.headers.get('content-type') || 'image/png';
        const safeMimeType = contentType.includes('gif') ? 'image/png' : contentType;
        return {
            data: Buffer.from(arrayBuffer),
            mimeType: safeMimeType,
        };
    } catch (error) {
        logger.debug({ err: error, emoteId }, 'Error fetching emote image');
        return null;
    }
}

// ---------------------------------------------------------------------------
// Cache: L1 (in-memory) + L2 (Firestore)
// ---------------------------------------------------------------------------

/**
 * Get a cached description for an emote, checking L1 then L2.
 * @param {string} emoteId
 * @returns {Promise<string | null>}
 */
async function getCachedDescription(emoteId) {
    // L1: in-memory cache
    const cached = descriptionCache.get(emoteId);
    if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
        return cached.description;
    }
    if (cached) {
        descriptionCache.delete(emoteId);
    }

    // L2: Firestore persistent cache
    if (emoteDescriptionsDb) {
        try {
            const doc = await emoteDescriptionsDb
                .collection(EMOTE_DESCRIPTIONS_COLLECTION)
                .doc(emoteId)
                .get();
            if (doc.exists) {
                const data = doc.data();
                if (data.description) {
                    // Populate L1 from L2 hit
                    descriptionCache.set(emoteId, { description: data.description, cachedAt: Date.now() });
                    logger.debug({ emoteId, emoteName: data.emoteName }, 'Emote description loaded from Firestore cache');
                    return data.description;
                }
            }
        } catch (error) {
            logger.warn({ err: error.message, emoteId }, 'Firestore emote description lookup failed, falling through to Gemini');
        }
    }

    return null;
}

/**
 * Cache a description in L1 and fire-and-forget to L2 (Firestore).
 * @param {string} emoteId
 * @param {string} description
 * @param {string} [emoteName]
 */
function cacheDescription(emoteId, description, emoteName) {
    // L1: in-memory
    descriptionCache.set(emoteId, { description, cachedAt: Date.now() });

    // L2: Firestore fire-and-forget
    if (emoteDescriptionsDb) {
        const data = { description, emoteName: emoteName || null, updatedAt: FieldValue.serverTimestamp() };
        emoteDescriptionsDb
            .collection(EMOTE_DESCRIPTIONS_COLLECTION)
            .doc(emoteId)
            .set(data, { merge: true })
            .catch(error => logger.warn({ err: error.message, emoteId }, 'Firestore emote description write failed'));
    }
}

/**
 * Describe a single emote using Gemini vision with structured JSON output.
 * @param {string} emoteId
 * @param {string} emoteName - The text name of the emote (e.g. "LUL")
 * @returns {Promise<string | null>}
 */
async function describeSingleEmote(emoteId, emoteName) {
    const cached = await getCachedDescription(emoteId);
    if (cached) return cached;

    if (!genAI) return null;

    const imageData = await fetchEmoteImage(emoteId);
    if (!imageData) {
        logger.info({ emoteId, emoteName }, 'Emote image fetch failed — cannot describe');
        return null;
    }

    try {
        const prompt = `Describe this Twitch emote named "${emoteName}" in 2-6 words for context. Use the emote name as a clue to identify the subject — but do not echo the raw emote token verbatim in your reply (individual meaningful words from the name are fine). Focus on what it visually depicts. Be concise. No word "emote".`;

        const contents = [
            {
                inlineData: {
                    mimeType: imageData.mimeType,
                    data: imageData.data.toString('base64'),
                },
            },
            { text: prompt },
        ];

        const response = await Promise.race([
            genAI.models.generateContent({
                model: geminiModel,
                systemInstruction: SYSTEM_INSTRUCTION,
                contents,
                config: {
                    responseMimeType: 'application/json',
                    responseJsonSchema: {
                        type: 'object',
                        properties: {
                            description: { type: 'string', description: 'A 2-6 word visual description of the emote.' },
                        },
                        required: ['description'],
                    },
                },
            }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Gemini timeout')), timeoutMs)
            ),
        ]);

        const parsed = JSON.parse(response.text);
        const description = parsed?.description?.trim().replace(/[.!?,;:]+$/g, '');
        if (description) {
            cacheDescription(emoteId, description, emoteName);
            logger.debug({ emoteId, emoteName, description }, 'Emote described by Gemini');
            return description;
        }
        return null;
    } catch (error) {
        logger.info({ err: error.message, emoteId, emoteName }, 'Gemini emote description failed');
        return null;
    }
}

/**
 * Get a standalone emote context string for use as LLM context.
 * Extracts emotes from EventSub message fragments, describes them via Gemini,
 * and returns a bracketed annotation string.
 *
 * @param {Object} tags - Message tags (must contain .fragments from EventSub)
 * @param {string} _message - Unused (kept for call-site compatibility)
 * @returns {Promise<string | null>} Context string like "[Emotes in message: Kappa = smirking face]", or null
 */
export async function getEmoteContextString(tags, _message) {
    if (!genAI || !tags?.fragments) return null;

    const emotes = extractEmotesFromFragments(tags.fragments);
    if (emotes.length === 0) return null;

    try {
        const descriptionResults = await Promise.all(
            emotes.map(async (emote) => {
                const description = await describeSingleEmote(emote.id, emote.name);
                return { ...emote, description };
            })
        );

        const described = descriptionResults.filter(r => r.description);
        if (described.length === 0) return null;

        const parts = described.map(r => `${r.name} = ${r.description}`);
        const contextStr = `[Emotes in message: ${parts.join(', ')}]`;

        logger.debug({ emoteCount: described.length, context: contextStr }, 'Built emote context string');
        return contextStr;
    } catch (error) {
        logger.info({ err: error.message }, 'Failed to build emote context string');
        return null;
    }
}

// For testing
export { descriptionCache as _descriptionCache };
