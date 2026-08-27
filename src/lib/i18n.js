// src/lib/i18n.js
//
// Static message catalogs — the *complementary* half of translationUtils.js.
//
//   translationUtils.js  -> dynamic text, translated at runtime by an LLM (costly, per-message)
//   i18n.js              -> fixed strings, looked up from committed JSON (free, instant, stable)
//
// A locale is either fully catalogued or not catalogued at all: every locale file must carry the
// exact same key set as en.json (enforced by tests/unit/lib/i18n.test.js). That invariant is what
// lets callers ask `isCatalogued(lang)` once and trust every subsequent lookup, rather than
// checking each key.
//
// Any miss — unknown locale, unknown key — returns null so the caller falls through to its English
// fallback and the existing runtime translation path. Lookups never throw and never guess.

import logger from './logger.js';
import en from '../locales/en.js';
import es from '../locales/es.js';
import fr from '../locales/fr.js';
import de from '../locales/de.js';
import it from '../locales/it.js';
import pt from '../locales/pt.js';
import ja from '../locales/ja.js';
import ru from '../locales/ru.js';

// Catalogs are ES modules rather than JSON read from disk: no path resolution, no import.meta
// (which the Jest/Babel CJS transform cannot parse), and no I/O at boot.
const RAW_CATALOGS = { en, es, fr, de, it, pt, ja, ru };

/** Locale codes with committed catalogs. Must stay identical to AVAILABLE_LANGUAGES in wildcat-docs. */
export const SUPPORTED_LOCALES = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ru'];

export const DEFAULT_LOCALE = 'en';

/**
 * Maps the free-text English language *names* that `!botlang` stores onto locale codes.
 * Covers every entry in COMMON_LANGUAGES (translationUtils.js) so that names outside the catalogued
 * eight still resolve to a code — `isCatalogued()` is what decides whether we have strings for it.
 */
export const LANGUAGE_NAME_TO_CODE = Object.freeze({
    english: 'en', spanish: 'es', french: 'fr', german: 'de', japanese: 'ja',
    portuguese: 'pt', italian: 'it', russian: 'ru', chinese: 'zh', korean: 'ko',
    dutch: 'nl', polish: 'pl', turkish: 'tr', arabic: 'ar', hindi: 'hi',
    vietnamese: 'vi', thai: 'th', swedish: 'sv', danish: 'da', norwegian: 'no',
    finnish: 'fi', greek: 'el', czech: 'cs', hungarian: 'hu', romanian: 'ro'
});

/** Reverse map, for turning Twitch's broadcaster_language code into a name the LLM prompts expect. */
const CODE_TO_LANGUAGE_NAME = Object.freeze(
    Object.fromEntries(Object.entries(LANGUAGE_NAME_TO_CODE).map(([name, code]) => [code, name]))
);

const catalogs = new Map();

/**
 * Flattens the imported catalogs into dotted-key lookup tables. Called once at boot; idempotent.
 * A catalog that fails to flatten is skipped rather than crashing the bot — that locale simply
 * stops being catalogued and falls back to runtime translation.
 */
export function loadCatalogs() {
    catalogs.clear();
    for (const [code, raw] of Object.entries(RAW_CATALOGS)) {
        try {
            catalogs.set(code, flatten(raw));
        } catch (err) {
            logger.error({ err, code }, `Failed to load locale catalog "${code}"; falling back to English for it`);
        }
    }
    logger.info({ locales: [...catalogs.keys()] }, `Loaded ${catalogs.size} message catalog(s)`);
}

// Populate immediately so lookups work even before initializeStorageComponents() runs
// (scripts and tests import this module directly).
loadCatalogs();

/** Flattens a nested catalog into dotted keys: { trivia: { start: "x" } } -> { "trivia.start": "x" } */
function flatten(obj, prefix = '', out = {}) {
    for (const [key, value] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            flatten(value, path, out);
        } else if (typeof value === 'string') {
            out[path] = value;
        }
    }
    return out;
}

/**
 * Normalizes either a locale code ('es') or an English language name ('spanish') to a locale code.
 * @param {string|null|undefined} language
 * @returns {string|null} Locale code, or null if unrecognized.
 */
export function toLocaleCode(language) {
    if (!language || typeof language !== 'string') return null;
    const key = language.trim().toLowerCase();
    if (!key) return null;
    if (LANGUAGE_NAME_TO_CODE[key]) return LANGUAGE_NAME_TO_CODE[key];
    // Accept codes directly, including region subtags ('pt-br' -> 'pt').
    const base = key.split('-')[0];
    if (CODE_TO_LANGUAGE_NAME[base]) return base;
    return null;
}

/**
 * Turns a locale code into the English language name used by the LLM prompts and `!botlang`.
 * @param {string|null|undefined} code e.g. 'es' or 'pt-BR'
 * @returns {string|null} e.g. 'spanish'
 */
export function nameFromCode(code) {
    if (!code || typeof code !== 'string') return null;
    return CODE_TO_LANGUAGE_NAME[code.trim().toLowerCase().split('-')[0]] || null;
}

/**
 * Whether we hold a committed catalog for this language. Because all catalogs share one key set,
 * a true result means *every* key resolves — so callers can decide `skipTranslation` up front.
 * English is catalogued but needs no translation, so it is reported as not requiring lookup.
 * @param {string|null|undefined} language Locale code or English language name.
 */
export function isCatalogued(language) {
    const code = toLocaleCode(language);
    return !!code && code !== DEFAULT_LOCALE && catalogs.has(code);
}

/**
 * Looks up a catalog string and interpolates {placeholders}.
 * @param {string} key Dotted key, e.g. 'trivia.start'.
 * @param {object} [params={}] Values for {placeholders} in the string.
 * @param {string|null} [language=null] Locale code or English language name.
 * @returns {string|null} The localized string, or null on any miss (unknown locale, missing key).
 */
export function t(key, params = {}, language = null) {
    const code = toLocaleCode(language);
    if (!code || code === DEFAULT_LOCALE) return null;
    const catalog = catalogs.get(code);
    if (!catalog) return null;
    const template = catalog[key];
    if (typeof template !== 'string') {
        logger.debug({ key, locale: code }, 'i18n key missing from catalog; using English fallback');
        return null;
    }
    return interpolate(template, params);
}

/** Replaces {name} placeholders. An absent param leaves the placeholder untouched rather than printing "undefined". */
function interpolate(template, params) {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) && params[name] !== undefined && params[name] !== null
            ? String(params[name])
            : match
    );
}

/**
 * The name of a language, written in the reader's own language.
 *
 * `!botlang` stores a free-text English name ("spanish"), so a status line would otherwise read
 * "El bot está configurado para hablar spanish". Intl.DisplayNames covers every locale we ship
 * without adding a name-per-language matrix to the catalogs.
 *
 * @param {string} language Locale code or English language name.
 * @param {string|null} [displayIn=null] Locale to write the name in; defaults to `language` itself.
 * @returns {string} The localized name, or the input unchanged if it cannot be resolved.
 */
export function localizedLanguageName(language, displayIn = null) {
    const code = toLocaleCode(language);
    if (!code) return String(language ?? '');
    const target = toLocaleCode(displayIn) || code;
    try {
        return new Intl.DisplayNames([target], { type: 'language' }).of(code) || String(language);
    } catch {
        return String(language);
    }
}
