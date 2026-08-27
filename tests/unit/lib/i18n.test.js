// tests/unit/lib/i18n.test.js

jest.mock('../../../src/lib/logger');

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import cat_en from '../../../src/locales/en.js';
import cat_es from '../../../src/locales/es.js';
import cat_fr from '../../../src/locales/fr.js';
import cat_de from '../../../src/locales/de.js';
import cat_it from '../../../src/locales/it.js';
import cat_pt from '../../../src/locales/pt.js';
import cat_ja from '../../../src/locales/ja.js';
import cat_ru from '../../../src/locales/ru.js';
import {
    t,
    msg,
    resolve,
    loadCatalogs,
    isCatalogued,
    toLocaleCode,
    nameFromCode,
    I18nMessage,
    SUPPORTED_LOCALES,
    DEFAULT_LOCALE
} from '../../../src/lib/i18n.js';

const LOCALES_DIR = join(process.cwd(), 'src', 'locales');
const RAW_CATALOGS = { en: cat_en, es: cat_es, fr: cat_fr, de: cat_de, it: cat_it, pt: cat_pt, ja: cat_ja, ru: cat_ru };

function flatten(obj, prefix = '', out = {}) {
    for (const [key, value] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, path, out);
        else out[path] = value;
    }
    return out;
}

const readCatalog = code => flatten(RAW_CATALOGS[code]);
const placeholdersOf = str => (str.match(/\{(\w+)\}/g) || []).sort();
const commandsOf = str => (str.match(/![a-z]+/g) || []).sort();

beforeAll(() => {
    loadCatalogs();
});

describe('i18n lookup', () => {
    it('returns null for an uncatalogued language so the caller falls back to English', () => {
        expect(t('trivia.stop', { answer: 'Paris' }, 'thai')).toBeNull();
        expect(t('trivia.stop', { answer: 'Paris' }, 'klingon')).toBeNull();
    });

    it('returns null for English, which needs no lookup', () => {
        expect(t('trivia.stop', { answer: 'Paris' }, 'english')).toBeNull();
        expect(t('trivia.stop', { answer: 'Paris' }, 'en')).toBeNull();
    });

    it('returns null for a missing key rather than throwing', () => {
        expect(t('trivia.doesNotExist', {}, 'spanish')).toBeNull();
    });

    it('returns null when no language is given', () => {
        expect(t('trivia.stop', {}, null)).toBeNull();
        expect(t('trivia.stop', {})).toBeNull();
    });

    it('interpolates placeholders', () => {
        const out = t('trivia.stop', { roundPrefix: '', answer: 'Paris' }, 'spanish');
        expect(out).toEqual(expect.stringContaining('Paris'));
        expect(out).not.toEqual(expect.stringContaining('{answer}'));
    });

    it('leaves a placeholder intact when its value is missing, rather than printing undefined', () => {
        const out = t('trivia.stop', { roundPrefix: '' }, 'spanish');
        expect(out).toEqual(expect.stringContaining('{answer}'));
        expect(out).not.toEqual(expect.stringContaining('undefined'));
    });
});

describe('language name and code mapping', () => {
    it('maps English names to locale codes', () => {
        expect(toLocaleCode('spanish')).toBe('es');
        expect(toLocaleCode('Spanish')).toBe('es');
        expect(toLocaleCode('  JAPANESE  ')).toBe('ja');
    });

    it('accepts codes directly and strips region subtags', () => {
        expect(toLocaleCode('es')).toBe('es');
        expect(toLocaleCode('pt-BR')).toBe('pt');
    });

    it('returns null for unknown or empty input', () => {
        expect(toLocaleCode('klingon')).toBeNull();
        expect(toLocaleCode('')).toBeNull();
        expect(toLocaleCode(null)).toBeNull();
        expect(toLocaleCode(undefined)).toBeNull();
    });

    it('maps Twitch broadcaster_language codes back to names', () => {
        expect(nameFromCode('es')).toBe('spanish');
        expect(nameFromCode('pt-BR')).toBe('portuguese');
        expect(nameFromCode('en')).toBe('english');
        expect(nameFromCode('zz')).toBeNull();
        expect(nameFromCode(null)).toBeNull();
    });
});

describe('isCatalogued', () => {
    it('is true for a locale with a committed catalog', () => {
        expect(isCatalogued('spanish')).toBe(true);
        expect(isCatalogued('es')).toBe(true);
    });

    it('is false for English, which needs no catalog lookup', () => {
        expect(isCatalogued('english')).toBe(false);
        expect(isCatalogued(null)).toBe(false);
    });

    it('is false for a language we hold no catalog for', () => {
        expect(isCatalogued('thai')).toBe(false);
        expect(isCatalogued('klingon')).toBe(false);
    });
});

describe('I18nMessage', () => {
    it('stringifies to its English fallback so concatenation keeps working', () => {
        const m = msg('trivia.stop', { answer: 'Paris' }, '🛑 Game stopped. The answer was: Paris');
        expect(`${m}`).toBe('🛑 Game stopped. The answer was: Paris');
        expect(m.length).toBe('🛑 Game stopped. The answer was: Paris'.length);
    });

    it('resolves to the catalog string for a catalogued language', () => {
        const m = msg('trivia.stop', { roundPrefix: '', answer: 'Paris' }, 'FALLBACK');
        expect(resolve(m, 'spanish')).not.toBe('FALLBACK');
        expect(resolve(m, 'spanish')).toEqual(expect.stringContaining('Paris'));
    });

    it('resolves to the fallback for an uncatalogued language', () => {
        const m = msg('trivia.stop', { answer: 'Paris' }, 'FALLBACK');
        expect(resolve(m, 'thai')).toBe('FALLBACK');
        expect(resolve(m, null)).toBe('FALLBACK');
    });

    it('passes plain strings through untouched', () => {
        expect(resolve('plain', 'spanish')).toBe('plain');
    });

    it('is what instanceof checks in ircSender rely on', () => {
        expect(msg('a.b', {}, 'x')).toBeInstanceOf(I18nMessage);
    });
});

describe('catalog integrity', () => {
    const english = readCatalog(DEFAULT_LOCALE);
    const englishKeys = Object.keys(english).sort();
    const otherLocales = SUPPORTED_LOCALES.filter(c => c !== DEFAULT_LOCALE);

    it('ships a catalog module for every supported locale and nothing else', () => {
        const onDisk = readdirSync(LOCALES_DIR).filter(f => f.endsWith('.js')).map(f => f.replace(/\.js$/, ''));
        expect(onDisk.sort()).toEqual([...SUPPORTED_LOCALES].sort());
    });

    it('imports a catalog for every supported locale', () => {
        expect(Object.keys(RAW_CATALOGS).sort()).toEqual([...SUPPORTED_LOCALES].sort());
    });

    // The "a locale is either fully catalogued or not at all" invariant that isCatalogued() relies on.
    it.each(otherLocales)('%s has exactly the same key set as en.js', code => {
        expect(Object.keys(readCatalog(code)).sort()).toEqual(englishKeys);
    });

    it.each(otherLocales)('%s preserves every {placeholder} from the English source', code => {
        const catalog = readCatalog(code);
        const drift = englishKeys
            .filter(key => placeholdersOf(catalog[key]).join() !== placeholdersOf(english[key]).join())
            .map(key => `${key}: expected ${placeholdersOf(english[key]).join()}, got ${placeholdersOf(catalog[key]).join()}`);
        expect(drift).toEqual([]);
    });

    it.each(otherLocales)('%s preserves every !command literal from the English source', code => {
        const catalog = readCatalog(code);
        const drift = englishKeys
            .filter(key => commandsOf(catalog[key]).join() !== commandsOf(english[key]).join())
            .map(key => `${key}: expected ${commandsOf(english[key]).join()}, got ${commandsOf(catalog[key]).join()}`);
        expect(drift).toEqual([]);
    });

    it.each(otherLocales)('%s has no empty values', code => {
        const catalog = readCatalog(code);
        expect(englishKeys.filter(key => !String(catalog[key]).trim())).toEqual([]);
    });
});
