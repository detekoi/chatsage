#!/usr/bin/env node
// scripts/test-checkin-prompts.js
// Tests prompt variations for the daily check-in feature
// Focus: how the model handles count=1 (first ever check-in)
// Usage: node scripts/test-checkin-prompts.js

import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) { console.error('❌ GEMINI_API_KEY not found'); process.exit(1); }

const MODEL = 'gemini-3.1-flash-lite-preview';
const ai = new GoogleGenAI({ apiKey: API_KEY });

const SYSTEM = `You are a fun Twitch chat bot. Respond to the following prompt in a single short message suitable for Twitch chat. Do NOT use markdown. Be concise, engaging. Keep your response under 300 characters.`;

const USER = 'idzuna';

const testCases = [
    // --- The original prompt (broken) ---
    {
        label: '❌ Original (ambiguous)',
        prompt: `Note that ${USER} just checked in for time # 1. React with quiet warmth and a touch of wit, like someone who genuinely notices the regulars. Do not say "part of the furniture."`,
    },
    // --- Count=1 fixes ---
    {
        label: '🔧 Fix: "their 1st total check-in"',
        prompt: `${USER} just made their 1st total check-in ever. React with quiet warmth and a touch of wit, like someone who genuinely notices newcomers. (This is their first time, not first today.)`,
    },
    {
        label: '🔧 Fix: explicit "all-time" phrasing',
        prompt: `${USER} just completed check-in number 1 all-time. Welcome them warmly but with a touch of wit. Keep it brief.`,
    },
    {
        label: '🔧 Fix: "joining the regulars" framing',
        prompt: `${USER} just did their very first daily check-in (total check-ins: 1). Greet them like they\'ve just started becoming a regular. Warm and slightly witty.`,
    },
    // --- Count=14 (returning user) ---
    {
        label: '✅ Returning user count=14',
        prompt: `Note that ${USER} just checked in for the 14th time total. React with quiet warmth and a touch of wit, like someone who genuinely notices the regulars. Do not say "part of the furniture."`,
    },
    {
        label: '✅ Returning user - ordinal phrasing',
        prompt: `${USER} just made their 14th check-in ever. Acknowledge it warmly and wittily. One sentence.`,
    },
    // --- Richer system instruction approach ---
    {
        label: '🔧 Richer prompt with context',
        prompt: `${USER} has checked in ${1} time(s) total across all sessions. This number reflects their cumulative loyalty, not just today. React with genuine warmth and a touch of wit. If count is 1, welcome them as a newcomer. If count is high, acknowledge their dedication.`,
    },
];

async function runTest(tc) {
    process.stdout.write(`\n${'─'.repeat(60)}\n`);
    process.stdout.write(`${tc.label}\n`);
    process.stdout.write(`Prompt: "${tc.prompt.slice(0, 100)}..."\n`);
    const start = Date.now();
    try {
        const result = await ai.models.generateContent({
            model: MODEL,
            contents: [{ role: 'user', parts: [{ text: tc.prompt }] }],
            config: { systemInstruction: { parts: [{ text: SYSTEM }] } }
        });
        const text = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '(empty)';
        const ms = Date.now() - start;
        process.stdout.write(`Response (${ms}ms, ${text.length}ch): "${text}"\n`);
        return { label: tc.label, text, ms, ok: true };
    } catch (e) {
        process.stdout.write(`ERROR: ${e.message}\n`);
        return { label: tc.label, ok: false };
    }
}

async function main() {
    console.log(`🧪 Check-In Prompt Quality Test — Model: ${MODEL}\n`);
    const results = [];
    for (const tc of testCases) {
        results.push(await runTest(tc));
    }
    const avgMs = Math.round(results.filter(r => r.ok).reduce((s, r) => s + r.ms, 0) / results.filter(r => r.ok).length);
    console.log(`\n${'═'.repeat(60)}\nDone — avg latency: ${avgMs}ms\n`);
}

main();
