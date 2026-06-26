// src/lib/geminiEmoteDescriber.js
// Uses Google Gemini Flash Lite to describe Twitch emotes visually for LLM context enrichment.
// Works directly with EventSub message fragments. Supports animated emotes via sharp.
import sharp from 'sharp';
import { getGenAIInstance } from '../components/llm/geminiClient.js';
import { getFirestore, FieldValue } from './firestore.js';
import config from '../config/index.js';
import logger from './logger.js';

const { geminiModel, cdnUrl, timeoutMs, animatedTimeoutMs } = config.emote;
const EMOTE_IMAGE_FORMAT = 'static/dark/3.0';
const ANIMATED_EMOTE_IMAGE_FORMAT = 'animated/dark/3.0';

// System instruction for emote descriptions in LLM chat context.
// Adapted from TTS version: framing is for "understanding" rather than "reading aloud".
const SYSTEM_INSTRUCTION = `You are a visual assistant that describes Twitch emotes so a chat AI can understand them. Your goal is precise, context-rich visual descriptions.

Rules:
- Reply with ONLY the short description — no preamble, no quotes, no trailing punctuation.
- Do not output the emote's raw alphanumeric string verbatim (e.g. do not say "parfai14Parfait" or "LUL"). You may use meaningful English words embedded in the name (e.g. "parfait dessert" from "parfai14Parfait" is fine), but do not begin your reply with the full emote token itself.
- When describing pride flags, always name the specific flag rather than generic terms. Examples: "rainbow Pride flag", "bisexual Pride flag", "transgender Pride flag", "lesbian Pride flag", "pansexual Pride flag", "nonbinary Pride flag", "asexual Pride flag". These are important cultural identifiers and accurate naming is essential.
- Prioritize the emotional meaning or sentiment the emote conveys (e.g. sarcasm, excitement, sadness) over purely literal visual detail.`;

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

let genAIInstance = null;
function getGenAI() {
    if (genAIInstance) return genAIInstance;
    try {
        genAIInstance = getGenAIInstance();
        return genAIInstance;
    } catch (e) {
        return null;
    }
}

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
        const client = getGenAI();
        if (!client) {
            throw new Error('Shared GenAI client not initialized');
        }
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
 * Extract unique emotes from EventSub message fragments.
 * Captures format metadata (animated/static) from the fragment.
 * @param {Array<{type: string, text: string, emote?: {id: string, owner_id?: string, format?: string[]}}>} fragments
 * @returns {Array<{id: string, name: string, count: number, isAnimated: boolean}>} Deduplicated emote entries
 */
export function extractEmotesFromFragments(fragments) {
    if (!Array.isArray(fragments) || fragments.length === 0) return [];

    const emoteCounts = new Map(); // emoteId -> { name, count, isAnimated }

    for (const frag of fragments) {
        if (frag.type !== 'emote' || !frag.emote?.id) continue;

        const id = frag.emote.id;
        const existing = emoteCounts.get(id);
        if (existing) {
            existing.count++;
        } else {
            const isAnimated = Array.isArray(frag.emote.format) && frag.emote.format.includes('animated');
            emoteCounts.set(id, { name: frag.text, count: 1, isAnimated });
        }
    }

    return Array.from(emoteCounts.entries()).map(([id, { name, count, isAnimated }]) => ({
        id,
        name,
        count,
        isAnimated,
    }));
}

// ---------------------------------------------------------------------------
// Image fetching: static PNG + animated GIF frame extraction
// ---------------------------------------------------------------------------

/**
 * Get the static emote image URL from a Twitch emote ID.
 * @param {string} emoteId
 * @returns {string}
 */
export function getEmoteImageUrl(emoteId) {
    return `${cdnUrl}/${emoteId}/${EMOTE_IMAGE_FORMAT}`;
}

/**
 * Get the animated emote GIF URL from a Twitch emote ID.
 * @param {string} emoteId
 * @returns {string}
 */
export function getAnimatedEmoteUrl(emoteId) {
    return `${cdnUrl}/${emoteId}/${ANIMATED_EMOTE_IMAGE_FORMAT}`;
}

/**
 * Fetch an emote image with fallback logic and timeouts.
 * Tries animated first if requested, falls back to static.
 * @param {string} emoteId
 * @param {boolean} isAnimated
 * @returns {Promise<{data: Buffer, mimeType: string, wasAnimated: boolean} | null>}
 */
async function fetchBestEffortEmoteImage(emoteId, isAnimated) {
    if (isAnimated) {
        const frameStrip = await fetchAnimatedEmoteFrames(emoteId);
        if (frameStrip) {
            return { ...frameStrip, wasAnimated: true };
        }
    }
    const staticImage = await fetchEmoteImage(emoteId);
    if (staticImage) {
        return { ...staticImage, wasAnimated: false };
    }
    return null;
}

/**
 * Fetch an emote image as bytes (static PNG).
 * @param {string} emoteId
 * @returns {Promise<{data: Buffer, mimeType: string} | null>}
 */
async function fetchEmoteImage(emoteId) {
    try {
        const url = getEmoteImageUrl(emoteId);
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) {
            logger.debug({ emoteId, status: response.status }, 'Failed to fetch emote image');
            return null;
        }
        const arrayBuffer = await response.arrayBuffer();
        const contentType = response.headers.get('content-type') || 'image/png';
        // Use actual content type. If twitch returns image/gif for a static path, pass it as image/gif.
        return {
            data: Buffer.from(arrayBuffer),
            mimeType: contentType,
        };
    } catch (error) {
        logger.debug({ err: error, emoteId }, 'Error fetching emote image');
        return null;
    }
}

/**
 * Fetch an animated emote GIF and return it as a single tall vertical strip PNG.
 * All frames are stacked top-to-bottom by libvips and sent to Gemini,
 * which can interpret the full animation context from the strip.
 * @param {string} emoteId
 * @returns {Promise<{data: Buffer, mimeType: string} | null>}
 */
async function fetchAnimatedEmoteFrames(emoteId) {
    const pipelineStart = Date.now();
    try {
        const url = getAnimatedEmoteUrl(emoteId);
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) {
            logger.debug({ emoteId, status: response.status }, 'Failed to fetch animated emote GIF');
            return null;
        }
        const arrayBuffer = await response.arrayBuffer();
        const gifBuffer = Buffer.from(arrayBuffer);
        const fetchMs = Date.now() - pipelineStart;

        const extractStart = Date.now();
        const pipeline = sharp(gifBuffer, { animated: true });
        const { pages } = await pipeline.metadata();
        const stripData = await pipeline.png().toBuffer();
        const extractMs = Date.now() - extractStart;
        const totalMs = Date.now() - pipelineStart;

        logger.info({ emoteId, fetchMs, extractMs, totalMs, totalFrames: pages || 1 }, 'Animated emote strip extracted');
        return { data: stripData, mimeType: 'image/png' };
    } catch (error) {
        logger.info({ err: error.message, emoteId, pipelineMs: Date.now() - pipelineStart }, 'Error extracting animated emote frames');
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

// ---------------------------------------------------------------------------
// Gemini description
// ---------------------------------------------------------------------------

/**
 * Describe a single emote using Gemini vision with structured JSON output.
 * For animated emotes, fetches the GIF, extracts a frame strip via sharp,
 * and uses a motion-aware prompt. Falls back to static PNG on failure.
 *
 * @param {string} emoteId
 * @param {string} emoteName - The text name of the emote (e.g. "LUL")
 * @param {boolean} [isAnimated=false] - Whether the emote has an animated variant
 * @returns {Promise<string | null>}
 */
async function describeSingleEmote(emoteId, emoteName, isAnimated = false) {
    const cached = await getCachedDescription(emoteId);
    if (cached) return cached;

    const genAI = getGenAI();
    if (!genAI) return null;

    // Fetch the best available image format for this emote
    const emoteImageData = await fetchBestEffortEmoteImage(emoteId, isAnimated);
    if (!emoteImageData) {
        logger.info({ emoteId, emoteName }, 'Emote image fetch failed — cannot describe');
        return null;
    }

    const imageParts = [{
        inlineData: { mimeType: emoteImageData.mimeType, data: emoteImageData.data.toString('base64') },
    }];
    const animatedSuccess = emoteImageData.wasAnimated;

    try {
        // Chat-adapted prompts: focus on meaning/sentiment rather than pure visual description
        const prompt = animatedSuccess
            ? `This is a vertical animation strip of the Twitch emote "${emoteName}" — all frames are stacked top-to-bottom in sequence. Describe what happens across the animation in 2-8 words. Include the emotional intent or sentiment (e.g. excitement, sarcasm, celebration). Focus on the action or transformation depicted. Be concise. No word "emote".`
            : `Describe this Twitch emote named "${emoteName}" in 2-8 words. Include the emotional intent or sentiment it conveys (e.g. sarcasm, hype, sadness). Use the emote name as a clue to identify the subject — but do not echo the raw emote token verbatim in your reply (individual meaningful words from the name are fine). Be concise. No word "emote".`;

        const contents = [...imageParts, { text: prompt }];
        const effectiveTimeout = animatedSuccess ? animatedTimeoutMs : timeoutMs;

        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('Gemini timeout')), effectiveTimeout);
        });

        const response = await Promise.race([
            genAI.models.generateContent({
                model: geminiModel,
                contents,
                config: {
                    systemInstruction: SYSTEM_INSTRUCTION,
                    responseMimeType: 'application/json',
                    responseSchema: {
                        type: 'object',
                        properties: {
                            description: { type: 'string', description: 'A 2-8 word visual and emotional description of the emote.' },
                        },
                        required: ['description'],
                    },
                },
            }),
            timeoutPromise,
        ]).finally(() => {
            clearTimeout(timeoutId);
        });

        const parsed = JSON.parse(response.text);
        const description = parsed?.description?.trim().replace(/[.!?,;:]+$/g, '');
        if (description) {
            cacheDescription(emoteId, description, emoteName);
            logger.debug({ emoteId, emoteName, isAnimated, animatedSuccess, description }, 'Emote described by Gemini');
            return description;
        }
        return null;
    } catch (error) {
        logger.info({ err: error.message, emoteId, emoteName, isAnimated }, 'Gemini emote description failed');
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
    const genAI = getGenAI();
    if (!genAI || !tags?.fragments) return null;

    const emotes = extractEmotesFromFragments(tags.fragments);
    if (emotes.length === 0) return null;

    try {
        const descriptionResults = await Promise.all(
            emotes.map(async (emote) => {
                const description = await describeSingleEmote(emote.id, emote.name, emote.isAnimated);
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

/**
 * Fetch emote images as inline data parts for direct multimodal LLM input.
 * No Gemini API call — just fetches the images and labels them.
 * Reuses existing image fetch logic (static PNG + animated frame strip).
 *
 * @param {Object} tags - Message tags with .fragments from EventSub
 * @returns {Promise<Array<{inlineData: {mimeType: string, data: string}} | {text: string}>>}
 *   Array of Gemini content parts: one text label + one inlineData per emote.
 *   Returns empty array if no emotes found or all fetches fail.
 */
export async function getEmoteImageParts(tags) {
    if (!tags?.fragments) return [];

    const emotes = extractEmotesFromFragments(tags.fragments);
    if (emotes.length === 0) return [];

    try {
        const parts = [];
        const fetchResults = await Promise.all(
            emotes.map(async (emote) => {
                const imageData = await fetchBestEffortEmoteImage(emote.id, emote.isAnimated);
                return { ...emote, imageData };
            })
        );

        const successful = fetchResults.filter(r => r.imageData);
        if (successful.length === 0) return [];

        // Build a text label summarizing which emotes are attached
        const emoteNames = successful.map(r => r.name).join(', ');
        parts.push({ text: `[Emote images in this message: ${emoteNames}]` });

        // Add each emote image with its own label
        for (const result of successful) {
            parts.push({ text: `Emote Name: ${result.name}` });
            parts.push({
                inlineData: {
                    mimeType: result.imageData.mimeType,
                    data: result.imageData.data.toString('base64'),
                },
            });
        }

        logger.debug({ emoteCount: successful.length, emoteNames }, 'Built emote image parts for multimodal input');
        return parts;
    } catch (error) {
        logger.info({ err: error.message }, 'Failed to build emote image parts');
        return [];
    }
}

// For testing
export { descriptionCache as _descriptionCache };
