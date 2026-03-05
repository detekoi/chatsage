#!/usr/bin/env node
// scripts/test-checkin-ai.js
// Live smoke test: sends daily check-in prompts to Gemini and prints responses.
// Usage: node scripts/test-checkin-ai.js
//
// Requires GEMINI_API_KEY in .env

import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
    console.error('❌ GEMINI_API_KEY not found in .env');
    process.exit(1);
}

const MODEL = 'gemini-3-flash-preview';
const ai = new GoogleGenAI({ apiKey: API_KEY });

const SYSTEM_INSTRUCTION = `You are a fun Twitch chat bot. Respond to the following prompt in a single short message suitable for Twitch chat. Do NOT use markdown formatting (like **bold** or *italics*), as Twitch IRC does not support it. Be concise, engaging, and directly address the prompt. Keep your response under 300 characters.`;

const testCases = [
    {
        name: 'Basic check-in congratulation',
        prompt: 'Write a cute, humorous message for WildcatGamer checking in for the 14th time.',
    },
    {
        name: 'First-time check-in',
        prompt: 'Write a short welcome message for NewViewer checking in for the 1st time ever.',
    },
    {
        name: 'Milestone check-in (100th)',
        prompt: 'Write a celebratory message for LoyalFan checking in for the 100th time!',
    },
    {
        name: 'Check-in with channel context',
        prompt: 'Write a fun check-in message for StreamerBuddy on their 7th check-in in WildcatGamer\'s channel.',
    },
    {
        name: 'Prompt with emoji instruction',
        prompt: 'Write a short, encouraging message with exactly one emoji for QuietLurker on their 3rd daily check-in.',
    },
];

async function runTest(testCase) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`📝 ${testCase.name}`);
    console.log(`   Prompt: "${testCase.prompt}"`);
    console.log(`${'─'.repeat(60)}`);

    const start = Date.now();
    try {
        const result = await ai.models.generateContent({
            model: MODEL,
            contents: [{ role: 'user', parts: [{ text: testCase.prompt }] }],
            config: {
                systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
                thinkingConfig: { thinkingLevel: 'none' }
            }
        });

        const response = result.candidates?.[0]?.content?.parts?.[0]?.text;
        const elapsed = Date.now() - start;

        if (!response) {
            console.log(`   ⚠️  Empty response (${elapsed}ms)`);
            return { pass: false, name: testCase.name };
        }

        // Clean up formatting (same as promptResolver.js)
        let clean = response.trim();
        clean = clean.replace(/\*\*/g, '');
        clean = clean.replace(/_ /g, ' ');

        console.log(`   ✅ Response (${elapsed}ms, ${clean.length} chars):`);
        console.log(`   "${clean}"`);

        // Validate constraints
        const issues = [];
        if (clean.length > 450) issues.push(`Too long (${clean.length}/450)`);
        if (clean.includes('**')) issues.push('Contains bold markdown');

        if (issues.length) {
            console.log(`   ⚠️  Issues: ${issues.join(', ')}`);
        }

        return { pass: true, name: testCase.name, response: clean, elapsed };
    } catch (err) {
        const elapsed = Date.now() - start;
        console.log(`   ❌ Error (${elapsed}ms): ${err.message}`);
        return { pass: false, name: testCase.name, error: err.message };
    }
}

async function main() {
    console.log('🧪 Daily Check-In AI Smoke Test');
    console.log(`   Model: ${MODEL}`);
    console.log(`   System instruction: ${SYSTEM_INSTRUCTION.substring(0, 80)}...`);

    const results = [];
    for (const tc of testCases) {
        results.push(await runTest(tc));
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log('📊 Summary');
    const passed = results.filter(r => r.pass).length;
    console.log(`   ${passed}/${results.length} prompts returned valid responses`);
    if (results.some(r => r.elapsed)) {
        const avgMs = Math.round(results.filter(r => r.elapsed).reduce((s, r) => s + r.elapsed, 0) / passed);
        console.log(`   Average latency: ${avgMs}ms`);
    }
    console.log(`${'═'.repeat(60)}\n`);

    process.exit(passed === results.length ? 0 : 1);
}

main();
