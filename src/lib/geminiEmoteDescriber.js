// src/lib/geminiEmoteDescriber.js
// Uses Google Gemini Flash Lite to describe Twitch emotes visually for LLM context enrichment.
// Adapted from tts-twitch's geminiEmoteDescriber.js for IRC-based message handling.
import { GoogleGenAI } from '@google/genai';
import logger from './logger.js';

const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const EMOTE_CDN_URL = 'https://static-cdn.jtvnw.net/emoticons/v2';
const EMOTE_IMAGE_FORMAT = 'static/dark/3.0';
const GEMINI_TIMEOUT_MS = 8000;

// In-memory cache: emoteId -> { description, cachedAt }
const descriptionCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

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
        logger.info('Gemini emote describer initialized (model: %s)', GEMINI_MODEL);
        return true;
    } catch (error) {
        logger.error({ err: error }, 'Failed to initialize Gemini emote describer');
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
 * Parse emotes from tmi.js IRC tags and the original message text.
 * tmi.js provides tags.emotes as an object: { emoteId: ["start-end", ...], ... }
 * or null if no emotes.
 *
 * @param {Object|null} emotesTag - The tags.emotes object from tmi.js
 * @param {string} message - The original message text
 * @returns {Array<{id: string, name: string, count: number}>} Deduplicated emote entries
 */
export function parseEmotesFromIRC(emotesTag, message) {
    if (!emotesTag || typeof emotesTag !== 'object') return [];

    const emotes = [];
    const seen = new Set();

    for (const emoteId of Object.keys(emotesTag)) {
        if (seen.has(emoteId)) continue;
        seen.add(emoteId);

        const positions = emotesTag[emoteId];
        if (!Array.isArray(positions) || positions.length === 0) continue;

        // Extract the emote name from the first occurrence position
        const firstPos = positions[0];
        const [startStr, endStr] = firstPos.split('-');
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);

        if (isNaN(start) || isNaN(end) || start < 0 || end >= message.length) continue;

        const emoteName = message.substring(start, end + 1);

        emotes.push({
            id: emoteId,
            name: emoteName,
            count: positions.length,
        });
    }

    return emotes;
}

/**
 * Get the static emote image URL from a Twitch emote ID.
 * @param {string} emoteId
 * @returns {string}
 */
export function getEmoteImageUrl(emoteId) {
    return `${EMOTE_CDN_URL}/${emoteId}/${EMOTE_IMAGE_FORMAT}`;
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

/**
 * Get a cached description for an emote, or null if not cached/expired.
 * @param {string} emoteId
 * @returns {string | null}
 */
function getCachedDescription(emoteId) {
    const cached = descriptionCache.get(emoteId);
    if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
        return cached.description;
    }
    if (cached) {
        descriptionCache.delete(emoteId);
    }
    return null;
}

/**
 * Cache a description for an emote.
 * @param {string} emoteId
 * @param {string} description
 */
function cacheDescription(emoteId, description) {
    descriptionCache.set(emoteId, { description, cachedAt: Date.now() });
}

/**
 * Describe a single emote using Gemini Flash Lite vision.
 * @param {string} emoteId
 * @param {string} emoteName - The text name of the emote (e.g. "LUL")
 * @returns {Promise<string | null>}
 */
async function describeSingleEmote(emoteId, emoteName) {
    const cached = getCachedDescription(emoteId);
    if (cached) return cached;

    if (!genAI) return null;

    const imageData = await fetchEmoteImage(emoteId);
    if (!imageData) {
        logger.info({ emoteId, emoteName }, 'Emote image fetch failed — cannot describe');
        return null;
    }

    try {
        const prompt = `Describe this Twitch emote named "${emoteName}" in 2-6 words for context. Focus on what it depicts (emotion, action, character). Be concise and natural-sounding. Reply with ONLY the short description, no quotes or extra text.`;

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
                model: GEMINI_MODEL,
                contents,
            }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Gemini timeout')), GEMINI_TIMEOUT_MS)
            ),
        ]);

        const description = response.text?.trim().replace(/[.!?,;:]+$/g, '');
        if (description) {
            cacheDescription(emoteId, description);
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
 * Enrich a chat message by annotating emotes with AI-generated descriptions.
 * Emote names in the message are replaced with "emoteName (description)" annotations
 * so the LLM understands what the emotes visually depict.
 *
 * Falls back to the original message if enrichment fails.
 *
 * @param {Object} tags - tmi.js message tags (must contain .emotes)
 * @param {string} message - The original message text
 * @returns {Promise<string>} The enriched message, or the original if no emotes or on failure
 */
export async function enrichMessageWithEmoteDescriptions(tags, message) {
    if (!genAI || !tags?.emotes || !message) return message;

    const emotes = parseEmotesFromIRC(tags.emotes, message);
    if (emotes.length === 0) return message;

    try {
        // Describe all unique emotes in parallel
        const descriptionResults = await Promise.all(
            emotes.map(async (emote) => {
                const description = await describeSingleEmote(emote.id, emote.name);
                return { ...emote, description };
            })
        );

        // Build a replacement map: emoteName -> "emoteName (description)"
        // Only replace emotes that were successfully described
        const replacements = new Map();
        for (const result of descriptionResults) {
            if (result.description) {
                replacements.set(result.name, `${result.name} (${result.description})`);
            }
        }

        if (replacements.size === 0) return message;

        // Replace emote names in the message text (working from right to left
        // using positions to avoid offset issues)
        let enriched = message;
        const allPositions = [];

        for (const emoteId of Object.keys(tags.emotes)) {
            const positions = tags.emotes[emoteId];
            if (!Array.isArray(positions)) continue;
            for (const pos of positions) {
                const [startStr, endStr] = pos.split('-');
                const start = parseInt(startStr, 10);
                const end = parseInt(endStr, 10);
                if (isNaN(start) || isNaN(end)) continue;
                const emoteName = message.substring(start, end + 1);
                if (replacements.has(emoteName)) {
                    allPositions.push({ start, end, replacement: replacements.get(emoteName) });
                }
            }
        }

        // Sort positions from right to left so replacements don't shift offsets
        allPositions.sort((a, b) => b.start - a.start);

        for (const { start, end, replacement } of allPositions) {
            enriched = enriched.substring(0, start) + replacement + enriched.substring(end + 1);
        }

        logger.debug({ originalLength: message.length, enrichedLength: enriched.length, emotesDescribed: replacements.size }, 'Message enriched with emote descriptions');
        return enriched;
    } catch (error) {
        logger.info({ err: error.message }, 'Failed to enrich message with emote descriptions — using original');
        return message;
    }
}

// For testing
export { descriptionCache as _descriptionCache };
