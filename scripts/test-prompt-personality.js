#!/usr/bin/env node
// scripts/test-prompt-personality.js
// A/B test system instruction variants against realistic Twitch chat messages.
// Compares tone, brevity, vocabulary diversity, and latency across prompt variants.
//
// Usage: node scripts/test-prompt-personality.js
//        node scripts/test-prompt-personality.js --variant 1   (run only variant index 1)

import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { buildContextPrompt, CHAT_SAGE_SYSTEM_INSTRUCTION } from '../src/components/llm/gemini/prompts.js';

// ── Config ─────────────────────────────────────────────────────────────
const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) { console.error('❌ GEMINI_API_KEY not found in .env'); process.exit(1); }

const MODEL = process.env.GEMINI_MODEL_ID || 'gemini-3-flash-preview';
const ai = new GoogleGenAI({ apiKey: API_KEY });
const RUNS_PER_MESSAGE = 2; // Run each message N times per variant to check consistency

// ── System Instruction Variants ────────────────────────────────────────
// These pull from the actual production exports so the test always matches what ships.
// To experiment with tweaks, copy a variant and edit the system field inline.

const VARIANTS = [
    {
        name: 'Production',
        system: CHAT_SAGE_SYSTEM_INSTRUCTION,
    },
    // ────────────────────────────────────────────────────────────────────
    // Add experimental variants here. Copy a block and edit the system field.
    // {
    //     name: 'Experimental',
    //     system: `...`,
    // },
];

// ── Simulated Stream Context ───────────────────────────────────────────
const STREAM_CONTEXT = buildContextPrompt({
    channelName: 'parfaittest',
    streamGame: 'Elden Ring',
    streamTitle: 'late night elden ring grind | chill stream',
    streamTags: 'English, Chill, SoulsLike, FirstPlaythrough',
    chatSummary: 'Chat has been discussing the current boss fight and sharing tips. Some viewers are talking about the soundtrack. The mood is relaxed with occasional hype during close calls.',
    recentChatHistory: [
        'sleepysabrina: this area is so pretty',
        'turboicehusky: have you tried the sword of night and flame?',
        'idzuna: the music in this area slaps',
        'parfaittest: nah first playthrough going blind',
        'sleepysabrina: respect',
        'turboicehusky: oh you are in for a treat then',
        'idzuna: the boss at the end of this zone is wild',
        'parfaittest: no spoilers!!',
        'sleepysabrina: lips sealed',
    ].join('\n'),
});

// ── Test Messages ──────────────────────────────────────────────────────
// "chat" messages test general chat personality, "command" messages test !ask/!search detail.
const TEST_MESSAGES = [
    // General chat (should be tight with Chat variant)
    { label: 'Chat: Casual reaction',      user: 'sleepysabrina',  message: 'this stream is so cozy tonight',                          type: 'chat' },
    { label: 'Chat: Music comment',         user: 'idzuna',         message: 'the music in this game is incredible',                     type: 'chat' },
    { label: 'Chat: Hype moment',           user: 'sleepysabrina',  message: 'LETS GOOO that dodge was insane',                          type: 'chat' },
    { label: 'Chat: Minimal input',         user: 'turboicehusky',  message: 'lol',                                                     type: 'chat' },
    { label: 'Chat: Off-topic small talk',  user: 'sleepysabrina',  message: 'i just made the best cup of tea',                          type: 'chat' },
    // Command-style (should be detailed with Command variant)
    { label: 'Cmd: Knowledge question',     user: 'turboicehusky',  message: 'what level should you be for this area?',                  type: 'command' },
    { label: 'Cmd: Opinion prompt',         user: 'idzuna',         message: 'do you think fromsoft games are hard or just unfair?',     type: 'command' },
    { label: 'Cmd: Factual search',         user: 'turboicehusky',  message: 'what are the best ashes of war in elden ring?',            type: 'command' },
];

// ── Helpers ────────────────────────────────────────────────────────────

function wordFrequencies(text) {
    const words = text.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(w => w.length > 3);
    const freq = {};
    for (const w of words) freq[w] = (freq[w] || 0) + 1;
    return freq;
}

function flagRepeatedWords(freq, threshold = 3) {
    return Object.entries(freq).filter(([, c]) => c >= threshold).map(([w, c]) => `${w}(${c}x)`);
}

function checkViolations(text) {
    const issues = [];
    if (text.length > 450) issues.push(`over 450ch (${text.length})`);
    if (/\*\*/.test(text)) issues.push('contains **markdown**');
    if (/^(hey|hi|hello|yo)\b/i.test(text)) issues.push('starts with greeting');
    if (/as an ai/i.test(text)) issues.push('says "as an AI"');
    return issues;
}

// ── Runner ─────────────────────────────────────────────────────────────

async function runSingle(variant, testMsg) {
    const userPrompt = testMsg.type === 'command'
        ? `${STREAM_CONTEXT}\n\nUSER: ${testMsg.user}: ${testMsg.message}\nREPLY: ≤300 chars. Answer directly.`
        : `${STREAM_CONTEXT}\n\nUSER: ${testMsg.user} says: ${testMsg.message}`;
    const start = Date.now();
    try {
        const result = await ai.models.generateContent({
            model: MODEL,
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            config: {
                systemInstruction: { parts: [{ text: variant.system }] },
                tools: [{ googleSearch: {} }],
                responseMimeType: 'text/plain',
                thinkingConfig: { thinkingLevel: 'high' },
            },
        });
        const text = result.candidates?.[0]?.content?.parts?.filter(p => p.text).map(p => p.text).join('').trim() ?? '(empty)';
        const ms = Date.now() - start;
        return { ok: true, text, ms, len: text.length };
    } catch (e) {
        return { ok: false, text: `ERROR: ${e.message}`, ms: Date.now() - start, len: 0 };
    }
}

async function main() {
    // Parse --variant flag
    const variantArg = process.argv.indexOf('--variant');
    const selectedVariant = variantArg !== -1 ? parseInt(process.argv[variantArg + 1], 10) : null;
    const variants = selectedVariant !== null ? [VARIANTS[selectedVariant]] : VARIANTS;

    if (selectedVariant !== null && !VARIANTS[selectedVariant]) {
        console.error(`❌ Variant index ${selectedVariant} not found. Available: 0-${VARIANTS.length - 1}`);
        process.exit(1);
    }

    console.log(`\n🧪 Prompt Personality A/B Test`);
    console.log(`   Model: ${MODEL}`);
    console.log(`   Variants: ${variants.map(v => v.name).join(', ')}`);
    console.log(`   Messages: ${TEST_MESSAGES.length} × ${RUNS_PER_MESSAGE} runs each`);
    console.log(`${'═'.repeat(70)}`);

    // Collect all results: { variantName -> [{ label, run, text, ms, len, issues }] }
    const allResults = {};
    for (const v of variants) allResults[v.name] = [];

    for (const testMsg of TEST_MESSAGES) {
        console.log(`\n${'─'.repeat(70)}`);
        console.log(`💬 [${testMsg.label}] ${testMsg.user}: "${testMsg.message}"`);
        console.log(`${'─'.repeat(70)}`);

        for (const variant of variants) {
            for (let run = 0; run < RUNS_PER_MESSAGE; run++) {
                const result = await runSingle(variant, testMsg);
                const issues = result.ok ? checkViolations(result.text) : ['ERROR'];

                allResults[variant.name].push({
                    label: testMsg.label,
                    type: testMsg.type,
                    run: run + 1,
                    text: result.text,
                    ms: result.ms,
                    len: result.len,
                    issues,
                });

                const runLabel = RUNS_PER_MESSAGE > 1 ? ` [run ${run + 1}]` : '';
                const status = result.ok ? (issues.length ? '⚠️' : '✅') : '❌';
                console.log(`\n  📋 ${variant.name}${runLabel} (${result.ms}ms, ${result.len}ch):`);
                console.log(`     "${result.text}"`);
                if (issues.length) console.log(`     ${status} ${issues.join(', ')}`);
            }
        }
    }

    // ── Aggregate Summary ──────────────────────────────────────────────
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`📊 SUMMARY`);
    console.log(`${'═'.repeat(70)}`);

    for (const variant of variants) {
        const results = allResults[variant.name];
        const chatResults = results.filter(r => r.type === 'chat');
        const cmdResults = results.filter(r => r.type === 'command');

        const avgLen = (arr) => arr.length ? Math.round(arr.reduce((s, r) => s + r.len, 0) / arr.length) : 0;
        const avgMs = (arr) => arr.length ? Math.round(arr.reduce((s, r) => s + r.ms, 0) / arr.length) : 0;
        const flagged = results.filter(r => r.issues.length > 0).length;

        // Word frequency across ALL responses for this variant
        const allText = results.map(r => r.text).join(' ');
        const freq = wordFrequencies(allText);
        const repeated = flagRepeatedWords(freq, 3);

        console.log(`\n  ┌─ ${variant.name}`);
        console.log(`  │  Chat avg length: ${avgLen(chatResults)} ch | Command avg length: ${avgLen(cmdResults)} ch`);
        console.log(`  │  Chat avg latency: ${avgMs(chatResults)} ms | Command avg latency: ${avgMs(cmdResults)} ms`);
        console.log(`  │  Flagged: ${flagged}/${results.length}`);
        if (repeated.length) {
            console.log(`  │  🔁 Repeated words: ${repeated.join(', ')}`);
        } else {
            console.log(`  │  ✅ No repeated words (3+ uses)`);
        }

        // Top 10 words by frequency
        const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 10);
        console.log(`  │  Top words: ${top.map(([w, c]) => `${w}(${c})`).join(', ')}`);
        console.log(`  └${'─'.repeat(50)}`);
    }

    console.log(`\n${'═'.repeat(70)}\n`);
    const anyErrors = Object.values(allResults).flat().some(r => r.issues.includes('ERROR'));
    process.exit(anyErrors ? 1 : 0);
}

main();
