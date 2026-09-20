#!/usr/bin/env node
// scripts/translate-webui-catalog.js
//
// Generates the non-English dashboard catalogs in chatsage-web-ui/public/i18n from the *-en.json
// files. Shares its prompt, glossary, validation and drift detection with the bot's catalogs via
// scripts/lib/catalogTranslator.js, so both surfaces translate the same way.
//
// The web UI has no build step and no package.json at its root, so this lives here — where the LLM
// client already exists — and writes across to that repo.
//
// Usage:
//   node scripts/translate-webui-catalog.js
//   node scripts/translate-webui-catalog.js --locales es,ja
//   node scripts/translate-webui-catalog.js --force
//   node scripts/translate-webui-catalog.js --dry-run
//   node scripts/translate-webui-catalog.js --dir /path/to/chatsage-web-ui/public/i18n

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeLlmClient, generateLiteContent } from '../src/components/llm/llmClient.js';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from '../src/lib/i18n.js';
import {
    LANGUAGE_NAMES, DEFAULT_MODEL_ID, BATCH_SIZE,
    flatten, unflatten, hashOf, translateBatch, validate, parseFlag
} from './lib/catalogTranslator.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIR = join(REPO_ROOT, '..', 'chatsage-web-ui', 'public', 'i18n');

const readJson = (path, fallback) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback);

async function main() {
    const args = process.argv.slice(2);
    const force = args.includes('--force');
    const dryRun = args.includes('--dry-run');
    const modelId = parseFlag(args, 'model') || process.env.TRANSLATION_MODEL_ID || DEFAULT_MODEL_ID;
    const i18nDir = parseFlag(args, 'dir') || DEFAULT_DIR;
    const localesFlag = parseFlag(args, 'locales');
    const targets = (localesFlag ? localesFlag.split(',').filter(Boolean)
        : SUPPORTED_LOCALES.filter(c => c !== DEFAULT_LOCALE))
        .filter(code => {
            if (code === DEFAULT_LOCALE) return false;
            if (!LANGUAGE_NAMES[code]) {
                console.error(`Skipping unknown locale "${code}".`);
                return false;
            }
            return true;
        });

    if (!existsSync(i18nDir)) throw new Error(`No such directory: ${i18nDir} (pass --dir)`);

    // One catalog per page, plus the shared `common` chrome: common-en.json, dashboard-en.json, ...
    const pages = readdirSync(i18nDir)
        .filter(f => f.endsWith(`-${DEFAULT_LOCALE}.json`))
        .map(f => f.slice(0, -`-${DEFAULT_LOCALE}.json`.length))
        .sort();
    if (!pages.length) throw new Error(`No *-${DEFAULT_LOCALE}.json catalogs found in ${i18nDir}`);

    const hashFile = join(i18nDir, '.translation-hashes.json');
    const hashes = readJson(hashFile, {});

    console.log(`Directory: ${i18nDir}`);
    console.log(`Pages:     ${pages.join(', ')}`);
    console.log(`Model:     ${modelId}`);

    let llmReady = false;

    for (const page of pages) {
        const english = flatten(readJson(join(i18nDir, `${page}-${DEFAULT_LOCALE}.json`), {}));
        const englishKeys = Object.keys(english);
        if (!englishKeys.length) {
            console.log(`${page}: no keys, skipping`);
            continue;
        }

        for (const code of targets) {
            const outPath = join(i18nDir, `${page}-${code}.json`);
            const existing = flatten(readJson(outPath, {}));
            const hashKey = `${page}:${code}`;
            // Clone: mutating hashes[hashKey] in place would persist hashes for keys whose
            // catalog was never written on an aborted run, and the next run would skip them.
            const pageHashes = { ...(hashes[hashKey] || {}) };
            // Drop hashes for keys no longer in English, or they accumulate forever. Committed
            // immediately: pruning is independent of whether any translation work happens below.
            let pruned = 0;
            for (const key of Object.keys(pageHashes)) {
                if (!(key in english)) { delete pageHashes[key]; pruned++; }
            }
            if (pruned) hashes[hashKey] = pageHashes;

            const stale = englishKeys.filter(key =>
                force || existing[key] === undefined || pageHashes[key] !== hashOf(english[key]));
            const removed = Object.keys(existing).filter(key => !(key in english));

            if (!stale.length && !removed.length) {
                console.log(`${page}/${code}: up to date (${englishKeys.length} keys)`);
                continue;
            }
            console.log(`${page}/${code}: ${stale.length} to translate, ${removed.length} obsolete to drop`);
            if (dryRun) continue;

            if (!llmReady) { initializeLlmClient(); llmReady = true; }

            let updated = 0;
            const result = {};
            for (const key of englishKeys) if (existing[key] !== undefined) result[key] = existing[key];

            for (let i = 0; i < stale.length; i += BATCH_SIZE) {
                const batch = stale.slice(i, i + BATCH_SIZE);
                const entries = batch.map(key => ({ key, text: english[key] }));
                process.stdout.write(`   ${page}/${code} batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} keys... `);
                let translations;
                try {
                    translations = await translateBatch(generateLiteContent, LANGUAGE_NAMES[code], entries, modelId);
                } catch (err) {
                    console.log(`FAILED (${err.message}) — keeping previous values`);
                    continue;
                }
                let ok = 0;
                for (const key of batch) {
                    const translated = translations.get(key);
                    const problem = validate(english[key], translated);
                    if (problem) {
                        console.log(`\n     ! ${key}: ${problem} — left untranslated`);
                        continue;
                    }
                    result[key] = translated;
                    pageHashes[key] = hashOf(english[key]);
                    ok++;
                    updated++;
                }
                console.log(`${ok}/${batch.length} ok`);
            }

            const missing = englishKeys.filter(key => result[key] === undefined);
            if (missing.length) {
                // A partial catalog would silently render some of the page in English, so it is
                // better to leave the previous file in place and report the gap.
                console.error(`${page}/${code}: ABORTED — ${missing.length} key(s) missing (${missing.slice(0, 5).join(', ')}). Not written.`);
                continue;
            }
            if (updated === 0 && !removed.length) {
                console.error(`${page}/${code}: no keys translated (all batches failed). Left unchanged.`);
                continue;
            }

            writeFileSync(outPath, JSON.stringify(unflatten(result), null, 2) + '\n');
            hashes[hashKey] = pageHashes;
            console.log(`${page}/${code}: wrote ${englishKeys.length} keys (${updated} new, ${removed.length} dropped)`);
        }
    }

    if (!dryRun) writeFileSync(hashFile, JSON.stringify(hashes, null, 2) + '\n');
    console.log('Done.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
