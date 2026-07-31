#!/usr/bin/env node
// scripts/verify-translation.js
// Translation hot-path verification through the REAL translationUtils module.
//   LLM_PROVIDER=openai node scripts/verify-translation.js

import dotenv from 'dotenv';
// .env overrides stale system vars, but an explicitly shell-passed LLM_PROVIDER
// (e.g. `LLM_PROVIDER=gemini node scripts/...`) must win over .env.
const shellProvider = process.env.LLM_PROVIDER;
dotenv.config({ override: true });
if (shellProvider) process.env.LLM_PROVIDER = shellProvider;

const { default: config } = await import('../src/config/loader.js');
const { initializeLlmClient } = await import('../src/components/llm/llmClient.js');
const { parseTranslateCommand, translateText, SAME_LANGUAGE } = await import('../src/lib/translationUtils.js');

console.log(`[Verification] Provider: ${config.llm?.provider || 'gemini'}`);
initializeLlmClient(config);

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
}

// ── 1. Command parsing (LLM + heuristic-compatible cases) ──────────────
console.log('\n--- 1. Translate Command Parsing ---');
const parseCases = [
    { input: 'spanish', expect: { action: 'enable', language: 'spanish', targetUser: null } },
    { input: '@streamer french', expect: { action: 'enable', language: 'french', targetUser: 'streamer' } },
    { input: 'japanese @viewer42', expect: { action: 'enable', language: 'japanese', targetUser: 'viewer42' } },
    { input: 'stop', expect: { action: 'stop', targetUser: null } },
    { input: 'stop all', expect: { action: 'stop_all' } },
    { input: 'stop @viewer42', expect: { action: 'stop', targetUser: 'viewer42' } },
    { input: 'brazilian portuguese', expect: { action: 'enable', language: /portuguese/i } },
];

for (const { input, expect } of parseCases) {
    const start = Date.now();
    const parsed = await parseTranslateCommand(input, 'user123');
    const ms = Date.now() - start;
    let ok = !!parsed && parsed.action === expect.action;
    if (ok && 'targetUser' in expect) ok = (parsed.targetUser || null) === expect.targetUser;
    if (ok && expect.language) {
        ok = expect.language instanceof RegExp
            ? expect.language.test(parsed.language || '')
            : (parsed.language || '').toLowerCase() === expect.language;
    }
    check(`!translate ${input}`, ok, `${JSON.stringify(parsed)} (${ms}ms)`);
}

// ── 2. Translation + same-language detection across pairs ──────────────
console.log('\n--- 2. Text Translation & Detection ---');
const translationCases = [
    { text: 'Hello everyone in twitch chat!', target: 'Spanish', expectSame: false },
    { text: 'Good luck on the boss fight, you got this!', target: 'Japanese', expectSame: false },
    { text: 'Das Spiel sieht heute richtig gut aus', target: 'English', expectSame: false },
    { text: 'Buenas noches a todos', target: 'Spanish', expectSame: true },
    { text: 'gg', target: 'French', expectSame: null }, // short/ambiguous — report only
];

const latencies = [];
for (const { text, target, expectSame } of translationCases) {
    const start = Date.now();
    const result = await translateText(text, target);
    const ms = Date.now() - start;
    latencies.push(ms);
    const isSame = result === SAME_LANGUAGE || typeof result === 'symbol';
    const detail = `${isSame ? 'SAME_LANGUAGE' : `"${result}"`} (${ms}ms)`;
    if (expectSame === null) {
        console.log(`  ℹ️ "${text}" → ${target}: ${detail}`);
    } else if (expectSame) {
        check(`"${text}" → ${target} detected as same language`, isSame, detail);
    } else {
        check(`"${text}" → ${target} translated`, !isSame && !!result, detail);
    }
}

// ── 3. Cache hit ───────────────────────────────────────────────────────
console.log('\n--- 3. Cache ---');
{
    const start = Date.now();
    const cached = await translateText('Hello everyone in twitch chat!', 'Spanish');
    const ms = Date.now() - start;
    check('Repeat translation served from cache', ms < 50 && !!cached, `${ms}ms`);
}

const sorted = [...latencies].sort((a, b) => a - b);
const p50 = sorted[Math.floor(sorted.length / 2)];
console.log(`\n  Latency p50: ${p50}ms (budget ~1500ms) ${p50 <= 1500 ? '✅' : '⚠️ over budget'}`);

console.log(`\n${failures === 0 ? '✅ All translation verifications passed' : `❌ ${failures} verification(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
