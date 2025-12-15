import logger from './logger.js';
import { getGeminiClient } from '../components/llm/geminiClient.js';

// Translation cache with LRU-style eviction and time-based expiration
const translationCache = new Map();
const MAX_CACHE_SIZE = 200;
const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

// Periodic cleanup of expired entries - only start in production
let cleanupIntervalId = null;

if (process.env.NODE_ENV !== 'test') {
    cleanupIntervalId = setInterval(() => {
        const now = Date.now();
        for (const [key, value] of translationCache) {
            if (now - value.timestamp > CACHE_EXPIRY_MS) {
                translationCache.delete(key);
            }
        }
        logger.debug(`Translation cache cleanup: ${translationCache.size} entries remaining`);
    }, 4 * 60 * 60 * 1000); // Clean up every 4 hours
}

// Export cleanup function for tests
export function cleanupTranslationUtils() {
    if (cleanupIntervalId) {
        clearInterval(cleanupIntervalId);
        cleanupIntervalId = null;
    }
    translationCache.clear();
}

// Common languages for heuristic detection
export const COMMON_LANGUAGES = [
    'english', 'spanish', 'french', 'german', 'japanese',
    'portuguese', 'italian', 'russian', 'chinese', 'korean',
    'dutch', 'polish', 'turkish', 'arabic', 'hindi',
    'vietnamese', 'thai', 'swedish', 'danish', 'norwegian',
    'finnish', 'greek', 'czech', 'hungarian', 'romanian'
];

/**
 * Enhanced text extraction function similar to lurk command fixes
 * @param {Object} response - Gemini response object
 * @param {Object} candidate - Response candidate
 * @returns {string|null} Extracted text or null
 */
function extractTextFromResponse(response, candidate) {
    if (candidate?.content?.parts && Array.isArray(candidate.content.parts)) {
        const joined = candidate.content.parts.map(p => p?.text || '').join('').trim();
        if (joined) return joined;
    }
    if (typeof candidate?.text === 'string' && candidate.text.trim()) return candidate.text.trim();
    if (typeof response?.text === 'function') {
        const t = response.text();
        if (typeof t === 'string' && t.trim()) return t.trim();
    }
    if (typeof response?.text === 'string' && response.text.trim()) return response.text.trim();
    return null;
}

/**
 * Robust translation function with retry logic similar to lurk command fixes
 * @param {string} textToTranslate - The text to translate
 * @param {string} targetLanguage - The target language
 * @returns {Promise<string|null>} The translated text, or null on failure
 */
export async function translateText(textToTranslate, targetLanguage) {
    if (!textToTranslate || !targetLanguage) {
        logger.error('translateText called with missing text or target language.');
        return null;
    }

    // Create cache key with normalized inputs
    const cacheKey = `${targetLanguage.toLowerCase()}:${textToTranslate.toLowerCase().trim()}`;
    const now = Date.now();

    // Check cache first
    const cachedEntry = translationCache.get(cacheKey);
    if (cachedEntry && (now - cachedEntry.timestamp < CACHE_EXPIRY_MS)) {
        // Move to end (LRU behavior)
        translationCache.delete(cacheKey);
        translationCache.set(cacheKey, cachedEntry);
        logger.debug(`[TranslationCache] Cache hit for: "${textToTranslate.substring(0, 30)}..."`);
        return cachedEntry.translation;
    }
    const model = getGeminiClient();

    const translationPrompt = `You are a professional interpreter. Translate the following text from its original language into ${targetLanguage}.
Rules:
1. Output ONLY the translated text.
2. Do not explain the translation.
3. If the text is already in ${targetLanguage}, correct any grammar errors if clearly present, otherwise keep it as is.
4. Do not wrap the output in quotes.

Text to translate:
${textToTranslate}

Translation:`;

    logger.debug({ targetLanguage, textLength: textToTranslate.length }, 'Attempting translation Gemini API call');

    let translatedText = null;

    // Attempt 1: Standard translation with higher token limit
    try {
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: translationPrompt }] }],
            generationConfig: {
                maxOutputTokens: 2048, // Increased from 1024 to match recent fixes
                temperature: 0.3,
                responseMimeType: 'text/plain'
            }
        });
        const response = result;
        const candidate = response?.candidates?.[0];

        if (response.promptFeedback?.blockReason) {
            logger.warn({ blockReason: response.promptFeedback.blockReason }, 'Translation prompt blocked by Gemini safety settings.');
            return null;
        }

        if (candidate && candidate.finishReason !== 'SAFETY') {
            const text = extractTextFromResponse(response, candidate);
            logger.debug({
                phase: 'attempt1',
                finishReason: candidate?.finishReason,
                hasText: !!text,
                textPreview: text?.substring(0, 50)
            }, 'Translation attempt1 result');
            translatedText = text && text.length > 0 ? text : null;
        }
    } catch (e) {
        logger.warn({ err: e }, 'Translation attempt1 failed.');
    }

    // Attempt 2: Simplified prompt if first attempt failed
    if (!translatedText) {
        try {
            const simplePrompt = `Translate to ${targetLanguage}: ${textToTranslate}`;
            const result2 = await model.generateContent({
                contents: [{ role: 'user', parts: [{ text: simplePrompt }] }],
                generationConfig: {
                    maxOutputTokens: 1536,
                    temperature: 0.2,
                    responseMimeType: 'text/plain'
                }
            });
            const response2 = result2;
            const candidate2 = response2?.candidates?.[0];

            if (candidate2 && candidate2.finishReason !== 'SAFETY') {
                const text2 = extractTextFromResponse(response2, candidate2);
                logger.debug({
                    phase: 'attempt2',
                    finishReason: candidate2?.finishReason,
                    hasText: !!text2
                }, 'Translation attempt2 result');
                translatedText = text2 && text2.length > 0 ? text2 : null;
            }
        } catch (e2) {
            logger.warn({ err: e2 }, 'Translation attempt2 failed.');
        }
    }

    if (!translatedText) {
        logger.warn('Translation response missing extractable text.');
        return null;
    }

    // Only remove quotation marks if they surround the entire message
    const cleanedText = translatedText.replace(/^"(.*)"$/s, '$1').trim();

    // Cache the successful translation
    if (cleanedText && cleanedText.length > 0) {
        // Implement LRU eviction if cache is full
        if (translationCache.size >= MAX_CACHE_SIZE) {
            const oldestKey = translationCache.keys().next().value;
            translationCache.delete(oldestKey);
            logger.debug(`[TranslationCache] Evicted oldest entry: "${oldestKey.substring(0, 30)}..."`);
        }

        translationCache.set(cacheKey, {
            translation: cleanedText,
            timestamp: now
        });
        logger.debug(`[TranslationCache] Cached translation for: "${textToTranslate.substring(0, 30)}..." (cache size: ${translationCache.size})`);
    }

    logger.info({ targetLanguage, originalLength: textToTranslate.length, translatedLength: cleanedText.length }, 'Successfully generated translation from Gemini.');
    return cleanedText;
}