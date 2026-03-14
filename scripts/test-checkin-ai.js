#!/usr/bin/env node
// scripts/test-checkin-ai.js
// Smoke test for daily check-in AI responses.
// Tests response quality, variety, latency, and Twitch constraints.
// Usage: node scripts/test-checkin-ai.js

import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) { console.error('❌ GEMINI_API_KEY not found in .env'); process.exit(1); }

const MODEL = 'gemini-3.1-flash-lite-preview';
const ai = new GoogleGenAI({ apiKey: API_KEY });
const SYSTEM = `You are a Twitch chat bot. Respond to the following prompt in a single short message suitable for Twitch chat. No markdown formatting. Be concise and match the tone requested in the prompt. Keep your response under 300 characters. If a check-in count or number is mentioned, it refers to the viewer's cumulative all-time total check-ins.`;

const USER_PROMPT = `Note that $(user) just checked in for time # $(checkin_count). React with quiet warmth and a touch of wit, like someone who genuinely notices the regulars.`;

const testCases = [
    // Variety check: same prompt, different users/counts — run 3x to check repetition
    { user: 'idzuna',       count: 1,   label: '1st check-in (newcomer)' },
    { user: 'idzuna',       count: 1,   label: '1st check-in (repeat run)' },
    { user: 'idzuna',       count: 1,   label: '1st check-in (repeat run 2)' },
    { user: 'parfaitfair',  count: 42,  label: '42nd check-in (regular)' },
    { user: 'sleepysabrina',count: 7,   label: '7th check-in' },
    { user: 'turboicehusky',count: 100, label: '100th check-in (milestone)' },
];

async function runTest(tc) {
    const prompt = USER_PROMPT.replace('$(user)', tc.user).replace('$(checkin_count)', tc.count);
    process.stdout.write(`\n${'─'.repeat(60)}\n`);
    process.stdout.write(`📝 ${tc.label} — ${tc.user} #${tc.count}\n`);
    const start = Date.now();
    try {
        const result = await ai.models.generateContent({
            model: MODEL,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
                systemInstruction: { parts: [{ text: SYSTEM }] },
                temperature: 1.5,
            }
        });
        const text = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '(empty)';
        const ms = Date.now() - start;
        const issues = [];
        if (text.length > 450) issues.push(`too long (${text.length}ch)`);
        if (/\*\*/.test(text)) issues.push('contains markdown');
        process.stdout.write(`   ✅ (${ms}ms, ${text.length}ch): "${text}"\n`);
        if (issues.length) process.stdout.write(`   ⚠️  ${issues.join(', ')}\n`);
        return { ok: true, ms, text };
    } catch (e) {
        process.stdout.write(`   ❌ ERROR: ${e.message}\n`);
        return { ok: false };
    }
}

async function main() {
    console.log(`🧪 Daily Check-In AI Smoke Test\n   Model: ${MODEL}`);
    const results = [];
    for (const tc of testCases) results.push(await runTest(tc));
    const ok = results.filter(r => r.ok);
    const avgMs = ok.length ? Math.round(ok.reduce((s, r) => s + r.ms, 0) / ok.length) : 0;
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`📊 ${ok.length}/${results.length} passed — avg latency: ${avgMs}ms`);

    // Check variety: warn if any two count=1 responses are too similar
    const newcomerResponses = results.slice(0, 3).filter(r => r.ok).map(r => r.text);
    if (newcomerResponses.length === 3) {
        const allDiff = newcomerResponses[0] !== newcomerResponses[1] && newcomerResponses[1] !== newcomerResponses[2];
        console.log(`   Variety (3x count=1): ${allDiff ? '✅ all different' : '⚠️  some responses repeated'}`);
    }
    console.log(`${'═'.repeat(60)}\n`);
    process.exit(ok.length === results.length ? 0 : 1);
}

main();
