#!/usr/bin/env node
// scripts/test-timer-grounding.js
// Smoke test: validates that Gemini Google Search grounding works for timer-style prompts.
//
// The production timer flow uses `resolvePrompt` → `generateLiteContent` (flash-lite)
// which does NOT wire up Google Search grounding. This script tests:
//   1. The current behavior (flash-lite, no grounding) — expects stale/hallucinated answers
//   2. The grounded path (main model + googleSearch tool) — expects fresh, accurate answers
//   3. Optionally, flash-lite WITH grounding — to see if it's viable as an upgrade path
//
// Usage: node scripts/test-timer-grounding.js

import dotenv from 'dotenv';
dotenv.config({ override: true });
import { GoogleGenAI } from '@google/genai';
import { CHAT_SAGE_SYSTEM_INSTRUCTION } from '../src/components/llm/gemini/prompts.js';

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) { console.error('❌ GEMINI_API_KEY not found in .env'); process.exit(1); }

const ai = new GoogleGenAI({ apiKey: API_KEY });

const MAIN_MODEL = process.env.GEMINI_MODEL_ID || 'gemini-3-flash-preview';
const LITE_MODEL = process.env.GEMINI_LITE_MODEL_ID || 'gemini-flash-lite-latest';

// ── Timer-style system instruction (matches production promptResolver) ──────
const TIMER_SYSTEM = CHAT_SAGE_SYSTEM_INSTRUCTION;

// ── Test prompts that require post-cutoff knowledge ─────────────────────────
// These are queries whose correct answers require Google Search because
// they reference events after the model's training data cutoff.
const TEST_PROMPTS = [
    {
        label: 'Star Fox (2026) news',
        prompt: 'What is the latest news about Star Fox for Nintendo Switch 2?',
        expectKeywords: ['star fox', 'switch 2', 'nintendo'],
        description: 'Star Fox game announced or released for Switch 2 — post-cutoff event',
    },
    {
        label: 'Recent gaming news',
        prompt: 'What major game was announced or released this week?',
        expectKeywords: [],
        description: 'Should return CURRENT gaming news, not outdated info',
    },
    {
        label: 'Current date awareness',
        prompt: 'Give a fun fact about something that happened today in gaming history or pop culture',
        expectKeywords: [],
        description: 'Tests whether the model knows the actual current date',
    },
    {
        label: 'Twitch-relevant trending topic',
        prompt: 'What is trending on Twitch right now?',
        expectKeywords: ['twitch'],
        description: 'Requires live search to answer accurately',
    },
];

// ── Model configurations to test ───────────────────────────────────────────
const CONFIGS = [
    {
        name: `Lite (no grounding) — current timer path`,
        model: LITE_MODEL,
        tools: undefined,
        description: 'This is what prompt timers currently use via generateLiteContent',
    },
    {
        name: `Main + Google Search — search/unified path`,
        model: MAIN_MODEL,
        tools: [{ googleSearch: {} }],
        description: 'This is what !search and unified responses use',
    },
    {
        name: `Lite + Google Search — potential upgrade`,
        model: LITE_MODEL,
        tools: [{ googleSearch: {} }],
        description: 'Testing if flash-lite supports grounding (for a timer upgrade)',
    },
];

// ── Runner ──────────────────────────────────────────────────────────────────

async function runTest(config, testPrompt) {
    // Build a timer-style prompt with stream context (mimicking timerManager.fireTimer)
    const streamContext = 'Game: Planet Zoo | Title: Building a dream zoo | Uptime: 2h 15m';
    const fullPrompt = `${testPrompt.prompt}\n\n--- Stream Context ---\n${streamContext}`;

    const start = Date.now();
    try {
        const requestParams = {
            model: config.model,
            contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
            config: {
                systemInstruction: TIMER_SYSTEM,
                responseMimeType: 'text/plain',
            },
        };

        if (config.tools) {
            requestParams.config.tools = config.tools;
        }

        const result = await ai.models.generateContent(requestParams);
        const ms = Date.now() - start;

        const candidate = result?.candidates?.[0];
        const text = result?.text
            ?? candidate?.content?.parts?.filter(p => p.text).map(p => p.text).join('').trim()
            ?? '(empty)';

        // Check grounding metadata
        const groundingMeta = candidate?.groundingMetadata || null;
        const wasGrounded = !!groundingMeta;
        const searchQueries = groundingMeta?.webSearchQueries || [];
        const sources = Array.isArray(groundingMeta?.groundingChunks)
            ? groundingMeta.groundingChunks.slice(0, 3).map(c => c?.web?.uri).filter(Boolean)
            : [];

        // Check if expected keywords appear in response
        const lowerText = text.toLowerCase();
        const keywordHits = testPrompt.expectKeywords.filter(kw => lowerText.includes(kw));
        const keywordMisses = testPrompt.expectKeywords.filter(kw => !lowerText.includes(kw));

        return {
            ok: true,
            text,
            ms,
            len: text.length,
            wasGrounded,
            searchQueries,
            sources,
            keywordHits,
            keywordMisses,
        };
    } catch (e) {
        return {
            ok: false,
            text: `ERROR: ${e.message}`,
            ms: Date.now() - start,
            len: 0,
            wasGrounded: false,
            searchQueries: [],
            sources: [],
            keywordHits: [],
            keywordMisses: testPrompt.expectKeywords,
        };
    }
}

async function main() {
    console.log(`\n🧪 Timer Grounding / RAG / Google Search Test`);
    console.log(`   Main model: ${MAIN_MODEL}`);
    console.log(`   Lite model: ${LITE_MODEL}`);
    console.log(`   Prompts: ${TEST_PROMPTS.length}`);
    console.log(`   Configs: ${CONFIGS.length}`);
    console.log(`${'═'.repeat(70)}\n`);

    const allResults = {};
    for (const config of CONFIGS) allResults[config.name] = [];

    // Run sequentially per prompt so output is easy to compare side-by-side
    for (const testPrompt of TEST_PROMPTS) {
        console.log(`${'─'.repeat(70)}`);
        console.log(`📝 ${testPrompt.label}`);
        console.log(`   "${testPrompt.prompt}"`);
        console.log(`   ${testPrompt.description}`);
        console.log(`${'─'.repeat(70)}`);

        // Fire all configs for this prompt in parallel
        const jobs = CONFIGS.map(config =>
            runTest(config, testPrompt).then(result => ({ config, result }))
        );
        const results = await Promise.all(jobs);

        for (const { config, result } of results) {
            allResults[config.name].push({ label: testPrompt.label, ...result });

            const status = result.ok ? '✅' : '❌';
            const groundIcon = result.wasGrounded ? '🌐' : '💭';
            console.log(`\n  ${status} ${groundIcon} ${config.name} (${result.ms}ms, ${result.len}ch)`);
            console.log(`     "${result.text}"`);

            if (result.wasGrounded) {
                if (result.searchQueries.length) {
                    console.log(`     🔍 Queries: ${result.searchQueries.join(' | ')}`);
                }
                if (result.sources.length) {
                    console.log(`     📎 Sources: ${result.sources.join(', ')}`);
                }
            } else {
                console.log(`     ⚠️  No grounding metadata (answered from training data only)`);
            }

            if (result.keywordMisses.length) {
                console.log(`     ❌ Missing keywords: ${result.keywordMisses.join(', ')}`);
            }
        }
        console.log('');
    }

    // ── Summary ─────────────────────────────────────────────────────────────
    console.log(`${'═'.repeat(70)}`);
    console.log(`📊 SUMMARY`);
    console.log(`${'═'.repeat(70)}`);

    for (const config of CONFIGS) {
        const results = allResults[config.name];
        const total = results.length;
        const succeeded = results.filter(r => r.ok).length;
        const grounded = results.filter(r => r.wasGrounded).length;
        const avgMs = succeeded ? Math.round(results.filter(r => r.ok).reduce((s, r) => s + r.ms, 0) / succeeded) : 0;
        const avgLen = succeeded ? Math.round(results.filter(r => r.ok).reduce((s, r) => s + r.len, 0) / succeeded) : 0;

        console.log(`\n  ┌─ ${config.name}`);
        console.log(`  │  ${config.description}`);
        console.log(`  │  Passed: ${succeeded}/${total} | Grounded: ${grounded}/${total}`);
        console.log(`  │  Avg latency: ${avgMs}ms | Avg length: ${avgLen}ch`);
        console.log(`  └${'─'.repeat(50)}`);
    }

    // ── Key takeaway ────────────────────────────────────────────────────────
    const liteGrounded = allResults[CONFIGS[0].name].filter(r => r.wasGrounded).length;
    const mainGrounded = allResults[CONFIGS[1].name].filter(r => r.wasGrounded).length;

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`💡 KEY FINDINGS`);
    console.log(`${'═'.repeat(70)}`);

    if (liteGrounded === 0 && mainGrounded > 0) {
        console.log(`\n  ⚠️  Current timer path (flash-lite, no grounding) answered ALL prompts`);
        console.log(`     from training data only — no fresh search results.`);
        console.log(`     Main model with Google Search grounded ${mainGrounded}/${TEST_PROMPTS.length} prompts.`);
        console.log(`\n  → If you want timers to reference current events (e.g., "Star Fox news"),`);
        console.log(`    you'd need to wire up Google Search in generateLiteContent or`);
        console.log(`    route prompt timers through the main model with searchTool.`);
    } else if (liteGrounded > 0) {
        console.log(`\n  ✅ Flash-lite responded with grounding in ${liteGrounded} prompts!`);
        console.log(`     This is unexpected — verify the responses are actually fresh.`);
    }

    const liteWithSearchGrounded = allResults[CONFIGS[2].name].filter(r => r.wasGrounded).length;
    if (liteWithSearchGrounded > 0) {
        console.log(`\n  💡 Flash-lite WITH Google Search grounded ${liteWithSearchGrounded}/${TEST_PROMPTS.length} prompts.`);
        console.log(`     This could be a viable low-latency upgrade path for prompt timers.`);
    }

    console.log(`\n${'═'.repeat(70)}\n`);

    const anyErrors = Object.values(allResults).flat().some(r => !r.ok);
    process.exit(anyErrors ? 1 : 0);
}

main();
