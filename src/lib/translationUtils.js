import logger from './logger.js';
import { calculateStringSimilarity } from './stringUtils.js';
import { generateLiteContent } from '../components/llm/llmClient.js';
import { withLlmCaller } from '../components/llm/llmRequestLog.js';
import { TranslateCommandSchema, TranslationResponseSchema } from '../components/llm/schemaUtils.js';

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
    // Don't let the sweep timer keep short-lived processes (scripts, jest workers) alive
    cleanupIntervalId.unref?.();
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
        const responseText = await withLlmCaller('translate-command', () => generateLiteContent(prompt, {
            temperature: 0,
            responseSchema: TranslateCommandSchema
        }));

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


const CONTEXT_MESSAGE_MAX_CHARS = 200;

/**
 * Formats surrounding chat for the translation prompt.
 * @returns {string} Prompt section, or an empty string when there is no context
 */
function buildTranslationContextBlock(priorMessages, replyParent) {
    const clip = (text) => text.length > CONTEXT_MESSAGE_MAX_CHARS ? `${text.slice(0, CONTEXT_MESSAGE_MAX_CHARS)}…` : text;
    const sections = [];

    const prior = (Array.isArray(priorMessages) ? priorMessages : [])
        .filter(m => typeof m === 'string' && m.trim())
        .map(m => `- ${JSON.stringify(clip(m.trim()))}`);
    if (prior.length > 0) {
        sections.push(`Earlier messages from the same chatter, oldest first:\n${prior.join('\n')}`);
    }

    const parentText = typeof replyParent?.text === 'string' ? replyParent.text.trim() : '';
    if (parentText) {
        const who = replyParent.displayName || 'another chatter';
        sections.push(`The text is a reply to this message from ${who}:\n- ${JSON.stringify(clip(parentText))}`);
    }

    return sections.length > 0 ? `Context:\n${sections.join('\n\n')}` : '';
}

/**
 * Translates text using LLM lite content call.
 * Uses structured JSON output for both same-language detection and translation in one round-trip.
 * @param {string} textToTranslate - The text to translate
 * @param {string} targetLanguage - The target language
 * @param {object} [context] - Surrounding chat, used only to work out the language and meaning
 * @param {string[]} [context.priorMessages] - The same chatter's earlier messages, oldest first
 * @param {{displayName?: string, text?: string}|null} [context.replyParent] - The message this one replies to
 * @returns {Promise<string|Symbol|null>} The translated text, SAME_LANGUAGE if already in target language, or null on
 *   failure or when the model flags the text as untranslatable (too short or ambiguous)
 */
export async function translateText(textToTranslate, targetLanguage, { priorMessages = [], replyParent = null } = {}) {
    if (!textToTranslate || !targetLanguage) {
        logger.error('translateText called with missing text or target language.');
        return null;
    }

    const contextBlock = buildTranslationContextBlock(priorMessages, replyParent);
    // The same text can mean different things in different conversations, so only
    // context-free translations are cached
    const useCache = !contextBlock;

    // Create cache key with normalized inputs
    const cacheKey = `${targetLanguage.toLowerCase()}:${textToTranslate.toLowerCase().trim()}`;
    const now = Date.now();

    // Check cache first
    const cachedEntry = useCache ? translationCache.get(cacheKey) : null;
    if (cachedEntry && (now - cachedEntry.timestamp < CACHE_EXPIRY_MS)) {
        translationCache.delete(cacheKey);
        translationCache.set(cacheKey, cachedEntry);
        logger.debug(`[TranslationCache] Cache hit for: "${textToTranslate.substring(0, 30)}..."`);
        return cachedEntry.translation;
    }

    logger.debug({ targetLanguage, textLength: textToTranslate.length, hasContext: !useCache }, 'Attempting translation via lite model');

    const translationPrompt = `You are a professional interpreter for Twitch live-stream chat. Analyze the following text and translate it into ${targetLanguage}.
Rules:
1. If the text is already in ${targetLanguage}, set same_language to true and leave translated_text empty.
2. If the text is too short, ambiguous or meaningless to translate confidently, set untranslatable to true, leave translated_text empty, and explain why in notes.
3. Otherwise, set same_language and untranslatable to false and provide the translation in translated_text.
4. translated_text is posted to chat verbatim: it holds only the translation — no markdown, no quotes, no explanations, no commentary about meaning or ambiguity. Any such reasoning goes in notes, which only operators see. Leave notes empty for a routine translation; use it only when you skipped the text or had to pick a reading of ambiguous or misspelled text.
5. Chat messages often contain nicknames, game terms, and slang that may resemble foreign words — these are not indicators of a different language. When in doubt, prefer same_language = true.
6. Preserve all profanity exactly as-is in translation (e.g. swear words, vulgar language). Only replace extreme slurs (racial or homophobic slurs) with a bracketed placeholder like [slur].
${contextBlock ? `7. Use the context below only to work out which language the text is in and what it means. Translate only the text, never the context.

${contextBlock}
` : ''}
Text:
${textToTranslate}`;

    // Both attempts use structured output. A free-form fallback can't tell a translation
    // from the model's commentary about it, and that commentary ends up in chat.
    let translatedText = null;
    for (let attempt = 1; attempt <= 2 && !translatedText; attempt++) {
        let responseText;
        try {
            responseText = await withLlmCaller('translate', () => generateLiteContent(translationPrompt, {
                temperature: 0.3,
                maxOutputTokens: 2048,
                responseSchema: TranslationResponseSchema
            }));
        } catch (e) {
            logger.warn({ err: e, attempt }, 'Translation attempt failed.');
            continue;
        }
        if (!responseText) continue;

        let parsed;
        try {
            parsed = JSON.parse(responseText);
        } catch (parseErr) {
            logger.warn({ err: parseErr, attempt, responseLength: responseText.length }, 'Failed to parse structured translation response.');
            continue;
        }

        if (parsed.same_language === true) {
            logger.debug({ targetLanguage, notes: parsed.notes || undefined }, 'Message already in target language, skipping translation.');
            return SAME_LANGUAGE;
        }
        if (parsed.untranslatable === true) {
            logger.info({
                targetLanguage,
                text: textToTranslate.substring(0, 200),
                notes: parsed.notes || null
            }, '[Translate] Model declined to translate; skipping.');
            return null;
        }
        if (parsed.notes) {
            logger.info({
                targetLanguage,
                text: textToTranslate.substring(0, 200),
                notes: parsed.notes
            }, '[Translate] Translation notes');
        }
        // A blank or whitespace-only translation counts as a failed attempt, so the retry still runs
        translatedText = typeof parsed.translated_text === 'string' && parsed.translated_text.trim() ? parsed.translated_text : null;
    }

    if (!translatedText) {
        logger.warn({ targetLanguage, text: textToTranslate.substring(0, 200) }, 'Translation response missing extractable text.');
        return null;
    }

    let cleanedText = translatedText.replace(/^"(.*)"$/s, '$1').trim();
    cleanedText = cleanedText.replace(/\*\*/g, '').trim();

    if (!cleanedText) {
        logger.warn({
            targetLanguage,
            text: textToTranslate.substring(0, 200),
            rawTranslation: translatedText.substring(0, 200)
        }, 'Translation was empty after cleanup.');
        return null;
    }

    // Similarity safeguard: if the "translation" is nearly identical to the input, treat as same language.
    // Edit distance rather than a per-position match, so an inserted or fixed character doesn't misalign the rest.
    const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normOriginal = normalize(textToTranslate);
    const normTranslated = normalize(cleanedText);
    if (normOriginal.length > 0 && normTranslated.length > 0) {
        const similarity = calculateStringSimilarity(normOriginal, normTranslated);
        if (similarity >= 0.85) {
            logger.debug({ targetLanguage, similarity: similarity.toFixed(2) },
                'Translation too similar to original, treating as same language.');
            return SAME_LANGUAGE;
        }
    }

    // Cache the successful translation
    if (useCache) {
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

    logger.info({ targetLanguage, originalLength: textToTranslate.length, translatedLength: cleanedText.length }, 'Successfully generated translation from flash-lite.');
    return cleanedText;
}