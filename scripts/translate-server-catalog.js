#!/usr/bin/env node
// scripts/translate-server-catalog.js
//
// Generates the non-English server catalogs in chatsage-web-ui/functions/src/i18n/catalog.ts from
// the `en` map in that same file. Shares its prompt, glossary, validation and drift detection with
// the other two catalog scripts via scripts/lib/catalogTranslator.js.
//
// These strings are the `message` field of API responses, which the dashboard renders directly
// into a toast — so they need the same treatment as any other user-facing fixed string.
//
// Usage:
//   node scripts/translate-server-catalog.js [--locales es,ja] [--force] [--dry-run] [--file <path>]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeGeminiClient, generateLiteContent } from '../src/components/llm/llmClient.js';
import {
    LANGUAGE_NAMES, DEFAULT_MODEL_ID, BATCH_SIZE,
    hashOf, translateBatch, validate, parseFlag
} from './lib/catalogTranslator.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FILE = join(REPO_ROOT, '..', 'chatsage-web-ui', 'functions', 'src', 'i18n', 'catalog.ts');

/**
 * Reads one `const <locale>: Catalog = { ... };` block out of the TypeScript module.
 *
 * Brace matching skips over string literals: catalog values are LLM-generated prose and a stray
 * `{` or `}` inside one would otherwise unbalance the count and truncate the block.
 */
function readBlock(src, locale) {
    const marker = `const ${locale}: Catalog = `;
    const start = src.indexOf(marker);
    if (start === -1) throw new Error(`No catalog block for "${locale}"`);
    const open = src.indexOf('{', start);
    let depth = 0, i = open;
    for (; i < src.length; i++) {
        const c = src[i];
        if (c === '"' || c === "'" || c === '`') {
            const quote = c;
            i++;
            while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
            continue;
        }
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) break;
        }
    }
    if (depth !== 0) throw new Error(`Unbalanced catalog block for "${locale}"`);
    return { body: src.slice(open, i + 1), start: open, end: i + 1 };
}

/**
 * Parses a block body. The file is TypeScript, not JSON: the project's lint rule requires trailing
 * commas on multiline literals, and JSON.parse rejects those — so strip them before parsing.
 */
function parseBlock(body) {
    return JSON.parse(body.replace(/,(\s*[}\]])/g, '$1'));
}

/** Writes a block back with trailing commas, so the result satisfies the repo's lint rule. */
function writeBlock(src, locale, entries) {
    const { start, end } = readBlock(src, locale);
    const json = JSON.stringify(entries, null, 2);
    const withTrailingComma = json.replace(/\n\}$/, ',\n}');
    return src.slice(0, start) + withTrailingComma + src.slice(end);
}

async function main() {
    const args = process.argv.slice(2);
    const force = args.includes('--force');
    const dryRun = args.includes('--dry-run');
    const modelId = parseFlag(args, 'model') || process.env.TRANSLATION_MODEL_ID || DEFAULT_MODEL_ID;
    const file = parseFlag(args, 'file') || DEFAULT_FILE;
    const localesFlag = parseFlag(args, 'locales');
    const targets = (localesFlag ? localesFlag.split(',').filter(Boolean) : Object.keys(LANGUAGE_NAMES))
        .filter(code => {
            if (!LANGUAGE_NAMES[code]) { console.error(`Skipping unknown locale "${code}".`); return false; }
            return true;
        });

    if (!existsSync(file)) throw new Error(`No such file: ${file} (pass --file)`);
    let src = readFileSync(file, 'utf8');

    const english = parseBlock(readBlock(src, 'en').body);
    const englishKeys = Object.keys(english);
    if (!englishKeys.length) throw new Error('The `en` catalog is empty');

    const hashFile = join(dirname(file), '.translation-hashes.json');
    const hashes = existsSync(hashFile) ? JSON.parse(readFileSync(hashFile, 'utf8')) : {};

    console.log(`File:   ${file}`);
    console.log(`Source: ${englishKeys.length} keys`);
    console.log(`Model:  ${modelId}`);

    let llmReady = false;

    for (const code of targets) {
        const existing = parseBlock(readBlock(src, code).body);
        // Clone: mutating hashes[code] in place would persist hashes for keys whose catalog
        // was never written on an aborted run, and the next run would then skip them forever.
        const localeHashes = { ...(hashes[code] || {}) };
        // Drop hashes for keys no longer in English, or they accumulate forever. Committed
        // immediately: pruning is independent of whether any translation work happens below.
        let pruned = 0;
        for (const key of Object.keys(localeHashes)) {
            if (!(key in english)) { delete localeHashes[key]; pruned++; }
        }
        if (pruned) hashes[code] = localeHashes;

        const stale = englishKeys.filter(k =>
            force || existing[k] === undefined || localeHashes[k] !== hashOf(english[k]));
        const removed = Object.keys(existing).filter(k => !(k in english));

        if (!stale.length && !removed.length) {
            console.log(`${code}: up to date (${englishKeys.length} keys)`);
            continue;
        }
        console.log(`${code}: ${stale.length} to translate, ${removed.length} obsolete to drop`);
        if (dryRun) continue;

        if (!llmReady) { initializeGeminiClient(); llmReady = true; }

        let updated = 0;
        const result = {};
        for (const k of englishKeys) if (existing[k] !== undefined) result[k] = existing[k];

        for (let i = 0; i < stale.length; i += BATCH_SIZE) {
            const batch = stale.slice(i, i + BATCH_SIZE);
            process.stdout.write(`   ${code} batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} keys... `);
            let translations;
            try {
                translations = await translateBatch(
                    generateLiteContent, LANGUAGE_NAMES[code],
                    batch.map(k => ({ key: k, text: english[k] })), modelId);
            } catch (err) {
                console.log(`FAILED (${err.message}) — keeping previous values`);
                continue;
            }
            let ok = 0;
            for (const k of batch) {
                const translated = translations.get(k);
                const problem = validate(english[k], translated);
                if (problem) { console.log(`\n     ! ${k}: ${problem} — left untranslated`); continue; }
                result[k] = translated;
                localeHashes[k] = hashOf(english[k]);
                ok++; updated++;
            }
            console.log(`${ok}/${batch.length} ok`);
        }

        const missing = englishKeys.filter(k => result[k] === undefined);
        if (missing.length) {
            // A partial catalog silently mixes languages in the toast stream, so leave the
            // previous block in place and report the gap instead.
            console.error(`${code}: ABORTED — ${missing.length} key(s) missing (${missing.slice(0, 5).join(', ')}). Not written.`);
            continue;
        }
        if (updated === 0 && !removed.length) {
            console.error(`${code}: no keys translated (all batches failed). Left unchanged.`);
            continue;
        }

        src = writeBlock(src, code, result);
        writeFileSync(file, src);
        hashes[code] = localeHashes;
        console.log(`${code}: wrote ${englishKeys.length} keys (${updated} new, ${removed.length} dropped)`);
    }

    if (!dryRun) writeFileSync(hashFile, JSON.stringify(hashes, null, 2) + '\n');
    console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
