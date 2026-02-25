import { Type } from "@google/genai";
import logger from './logger.js';
import { getGeminiClient } from '../components/llm/geminiClient.js';
import { getGenAIInstance } from '../components/llm/gemini/core.js';

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

// Sentinel value returned when the message is already in the target language
export const SAME_LANGUAGE = Symbol('SAME_LANGUAGE');

// Common languages for heuristic detection
export const COMMON_LANGUAGES = [
    'english', 'spanish', 'french', 'german', 'japanese',
    'portuguese', 'italian', 'russian', 'chinese', 'korean',
    'dutch', 'polish', 'turkish', 'arabic', 'hindi',
    'vietnamese', 'thai', 'swedish', 'danish', 'norwegian',
    'finnish', 'greek', 'czech', 'hungarian', 'romanian'
];

// Schema for translate command parsing
const TranslateCommandSchema = {
    type: Type.OBJECT,
    properties: {
        action: {
            type: Type.STRING,
            description: "The action to take: 'enable' to start translation, 'stop' to stop for one user, 'stop_all' to stop all translations"
        },
        targetUser: {
            type: Type.STRING,
            nullable: true,
            description: "The username to target, or null if targeting self"
        },
        language: {
            type: Type.STRING,
            nullable: true,
            description: "The target language for translation, or null for stop actions"
        }
    },
    required: ['action']
};

/**
 * Heuristic fallback for parsing translate commands when LLM fails
 */
function parseTranslateCommandHeuristic(commandText, _invokingUsername) {
    const args = commandText.trim().split(/\s+/);
    if (args.length === 0) {
        return { action: 'enable', targetUser: null, language: null };
    }

    const first = args[0].toLowerCase();

    // Handle stop commands
    if (first === 'stop') {
        if (args.length > 1 && args[1].toLowerCase() === 'all') {
            return { action: 'stop_all', targetUser: null, language: null };
        }
        if (args.length > 1) {
            return { action: 'stop', targetUser: args[1].replace(/^@/, '').toLowerCase(), language: null };
        }
        return { action: 'stop', targetUser: null, language: null };
    }

    // Check if first arg is a known language
    const isKnownLang = (s) => COMMON_LANGUAGES.includes(s.toLowerCase());

    if (args.length === 1) {
        // Single arg = language for self
        return { action: 'enable', targetUser: null, language: args[0] };
    }

    // Two+ args: try to figure out which is language and which is user
    if (args[0].startsWith('@')) {
        return { action: 'enable', targetUser: args[0].replace(/^@/, '').toLowerCase(), language: args.slice(1).join(' ') };
    }
    if (args[args.length - 1].startsWith('@')) {
        return { action: 'enable', targetUser: args[args.length - 1].replace(/^@/, '').toLowerCase(), language: args.slice(0, -1).join(' ') };
    }
    if (isKnownLang(first)) {
        // First is language, last might be user
        return { action: 'enable', targetUser: args[args.length - 1].toLowerCase(), language: first };
    }
    if (isKnownLang(args[args.length - 1])) {
        // Last is language, first might be user
        return { action: 'enable', targetUser: first, language: args[args.length - 1] };
    }

    // Default: treat all as language for self
    return { action: 'enable', targetUser: null, language: args.join(' ') };
}

/**
 * Parse a translate command using LLM with chat context
 * Uses gemini-2.5-flash-lite for speed and cost efficiency
 *
 * @param {string} commandText - The command arguments (everything after "!translate")
 * @param {string} invokingUsername - The username of the person who invoked the command
 * @param {string} chatContext - Recent chat context to help interpret the command
 * @returns {Promise<{action: string, targetUser: string|null, language: string|null}>}
 */
export async function parseTranslateCommand(commandText, invokingUsername, chatContext = '') {
    if (!commandText?.trim()) {
        return { action: 'enable', targetUser: null, language: null };
    }

    const ai = getGenAIInstance();

    const prompt = `Parse this Twitch chat translate command and extract the action, target user, and language.

Command: !translate ${commandText}
Invoked by: ${invokingUsername}

${chatContext ? `Recent chat context:\n${chatContext}\n` : ''}
Rules:
- action: "enable" to start translating, "stop" to stop for one user, "stop_all" for "stop all"
- targetUser: The username to affect, or null if the invoker is targeting themselves
- language: The language to translate into (can be multi-word like "traditional chinese"), or null for stop actions
- Remove @ prefix from usernames
- If ambiguous, use chat context to identify who might need translation (e.g., someone speaking another language)
- Common patterns:
  - "!translate spanish" → enable, null, "spanish" (self)
  - "!translate @user french" → enable, "user", "french"
  - "!translate french @user" → enable, "user", "french"
  - "!translate stop" → stop, null, null (self)
  - "!translate stop @user" → stop, "user", null
  - "!translate stop all" → stop_all, null, null

Return JSON only.`;

    try {
        const result = await ai.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
                temperature: 0,
                responseMimeType: 'application/json',
                responseSchema: TranslateCommandSchema
            }
        });

        const responseText = result.candidates?.[0]?.content?.parts?.[0]?.text;
        if (responseText) {
            const parsed = JSON.parse(responseText);
            logger.debug({ commandText, parsed }, 'LLM parsed translate command');
            return {
                action: parsed.action || 'enable',
                targetUser: parsed.targetUser?.toLowerCase() || null,
                language: parsed.language || null
            };
        }

        logger.warn('Empty response from LLM for translate command parsing, falling back to heuristic');
        return parseTranslateCommandHeuristic(commandText, invokingUsername);

    } catch (err) {
        logger.warn({ err, commandText }, 'LLM translate command parsing failed, falling back to heuristic');
        return parseTranslateCommandHeuristic(commandText, invokingUsername);
    }
}

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
 * @returns {Promise<string|Symbol|null>} The translated text, SAME_LANGUAGE if already in target language, or null on failure
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

    logger.debug({ targetLanguage, textLength: textToTranslate.length }, 'Attempting translation Gemini API call');

    // --- Stage 1: Language detection via flash-lite (cheap & fast) ---
    try {
        const ai = getGenAIInstance();
        const detectResult = await ai.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: [{ role: 'user', parts: [{ text: `Is the following text written in ${targetLanguage}? Text: ${textToTranslate}` }] }],
            config: {
                temperature: 0,
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        same_language: {
                            type: Type.BOOLEAN,
                            description: `True if the text is already in ${targetLanguage}`
                        }
                    },
                    required: ['same_language']
                }
            }
        });

        const detectText = detectResult.candidates?.[0]?.content?.parts?.[0]?.text;
        if (detectText) {
            const detectParsed = JSON.parse(detectText);
            if (detectParsed.same_language === true) {
                logger.debug({ targetLanguage }, 'Message already in target language, skipping translation.');
                return SAME_LANGUAGE;
            }
        }
    } catch (detectErr) {
        // Detection failure is non-fatal — proceed with translation anyway
        logger.debug({ err: detectErr }, 'Language detection failed, proceeding with translation.');
    }

    // --- Stage 2: Translation via default bot model ---
    const model = getGeminiClient();
    let translatedText = null;

    // Attempt 1: Standard translation
    try {
        const translationPrompt = `You are a professional interpreter. Translate the following text into ${targetLanguage}.
Rules:
1. Output ONLY the translated text.
2. Do not explain the translation.
3. Do not wrap the output in quotes.

Text to translate:
${textToTranslate}

Translation:`;

        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: translationPrompt }] }],
            generationConfig: {
                maxOutputTokens: 2048,
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

    // Attempt 2: Simplified plain-text prompt if first attempt failed
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