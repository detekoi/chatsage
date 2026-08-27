// scripts/lib/catalogTranslator.js
//
// Shared build-time translation core, used by both catalog scripts:
//   scripts/translate-catalog.js        -> the bot's src/locales/*.js
//   scripts/translate-webui-catalog.js  -> chatsage-web-ui's public/i18n/*.json
//
// Translation happens once at build time and the output is committed, so quality matters far more
// than latency or cost. This deliberately does NOT use the flash-lite model that
// src/lib/translationUtils.js uses for per-message runtime translation.

import { createHash } from 'node:crypto';

export const DEFAULT_MODEL_ID = 'gemini-3.7-flash';
export const BATCH_SIZE = 20;

/** Locale code -> the language name given to the model. */
export const LANGUAGE_NAMES = {
    es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
    pt: 'Portuguese', ja: 'Japanese', ru: 'Russian'
};

/** Product nouns that must survive translation byte-for-byte. */
export const GLOSSARY = [
    'WildcatSage', 'WildcatTTS', 'Wildcat.chat', 'Chat Overlay', 'TTS', 'OBS', 'AI', 'Twitch'
];

export const BatchSchema = {
    type: 'object',
    properties: {
        translations: {
            type: 'array',
            description: 'One entry per input string, in the same order',
            items: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: 'The key echoed back unchanged' },
                    text: { type: 'string', description: 'The translated string' }
                },
                required: ['key', 'text']
            }
        }
    },
    required: ['translations']
};

// --- shape helpers ---

export function flatten(obj, prefix = '', out = {}) {
    for (const [key, value] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, path, out);
        else if (typeof value === 'string') out[path] = value;
    }
    return out;
}

export function unflatten(flat) {
    const out = {};
    for (const [path, value] of Object.entries(flat)) {
        const parts = path.split('.');
        let node = out;
        for (const part of parts.slice(0, -1)) {
            node[part] = node[part] || {};
            node = node[part];
        }
        node[parts.at(-1)] = value;
    }
    return out;
}

export const hashOf = str => createHash('sha256').update(str).digest('hex').slice(0, 16);

// Both token shapes must survive: {name} is the catalog's own interpolation, $(name) is the
// chat-variable syntax the bot expands at send time and users type into the dashboard.
const BRACE_TOKEN = /\{\w+\}/g;
const DOLLAR_TOKEN = /\$\([^)]*\)/g;

export const placeholdersOf = str =>
    [...String(str).match(BRACE_TOKEN) || [], ...String(str).match(DOLLAR_TOKEN) || []].sort().join();

const COMMAND_LITERAL = /![a-z]+/g;
export const commandsOf = str => (String(str).match(COMMAND_LITERAL) || []).sort().join();

const HTML_TAG = /<\/?([a-z]+)[^>]*>/g;
export const tagsOf = str => (String(str).match(HTML_TAG) || []).map(t => t.toLowerCase()).sort().join();

// --- prompt + call ---

export function buildPrompt(languageName, entries) {
    return `You are localizing UI strings for a Twitch chat bot and its web dashboard into ${languageName}.

Translate the "text" of each entry below into ${languageName}. Return one entry per input, echoing each "key" back unchanged.

Rules — these matter more than fluency:
1. Preserve every {placeholder} EXACTLY as written. Do not translate them, do not change their spelling, do not invent new ones. A string containing {answer} must still contain {answer}.
2. Preserve every $(variable) token EXACTLY as written, including $(user), $(channel), $(count) and $(random X-Y). These are substituted at runtime.
3. Preserve every emoji, in the same position relative to the text.
4. Preserve any HTML tags exactly as written, translating only the text between them.
5. Preserve every chat command literal (anything starting with "!", such as !trivia or !command add) exactly as written in English. Only translate the surrounding prose and any <angle-bracket> parameter names.
6. Never translate these product names: ${GLOSSARY.join(', ')}.
7. Preserve leading and trailing whitespace exactly. Several of these strings are sentence fragments that get concatenated, so a leading or trailing space is load-bearing.
8. Keep the register casual and concise — this is a live stream chat product, not formal documentation. Keep translations about as short as the English; Twitch chat messages are capped at 500 characters and dashboard labels sit in narrow columns.

Entries:
${JSON.stringify(entries, null, 2)}`;
}

/**
 * Translates one batch.
 * @param {Function} generate The LLM call, (prompt, options) => Promise<string>.
 * @returns {Promise<Map<string,string>>} key -> translated text.
 */
export async function translateBatch(generate, languageName, entries, modelId) {
    const responseText = await generate(buildPrompt(languageName, entries), {
        temperature: 0.3,
        maxOutputTokens: 8192,
        responseSchema: BatchSchema,
        modelId
    });
    if (!responseText) throw new Error('Empty response from model');
    const parsed = JSON.parse(responseText);
    if (!Array.isArray(parsed.translations)) throw new Error('Response had no translations array');
    return new Map(parsed.translations.map(entry => [entry.key, entry.text]));
}

/**
 * Rejects a translation that dropped or mangled anything that must survive verbatim. These break
 * interpolation, variable expansion or markup at runtime, so they are worth failing loudly on.
 * @returns {string|null} A description of the problem, or null if the translation is usable.
 */
export function validate(english, translated) {
    if (typeof translated !== 'string' || !translated.trim()) return 'empty translation';
    if (placeholdersOf(translated) !== placeholdersOf(english)) {
        return `placeholder drift (expected ${placeholdersOf(english) || 'none'}, got ${placeholdersOf(translated) || 'none'})`;
    }
    if (commandsOf(translated) !== commandsOf(english)) {
        return `command literal drift (expected ${commandsOf(english) || 'none'}, got ${commandsOf(translated) || 'none'})`;
    }
    if (tagsOf(translated) !== tagsOf(english)) {
        return `HTML tag drift (expected ${tagsOf(english) || 'none'}, got ${tagsOf(translated) || 'none'})`;
    }
    return null;
}

/** Parses `--flag value` / `--flag=value` out of argv. */
export function parseFlag(args, name) {
    const arg = args.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!arg) return null;
    return arg.includes('=') ? arg.split('=').slice(1).join('=') : (args[args.indexOf(arg) + 1] ?? null);
}
