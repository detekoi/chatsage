#!/usr/bin/env node
// scripts/test-botlang-native.js
// Verify that appending a language directive to the system instruction
// causes Gemini to respond natively in the target language, avoiding
// the need for a separate post-hoc translation call.
//
// Usage:
//   node scripts/test-botlang-native.js
//   node scripts/test-botlang-native.js --lang spanish
//   node scripts/test-botlang-native.js --lang japanese --lang french

import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { buildContextPrompt, CHAT_SAGE_SYSTEM_INSTRUCTION } from '../src/components/llm/gemini/prompts.js';

// ── Config ─────────────────────────────────────────────────────────────
const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) { console.error('❌ GEMINI_API_KEY not found in .env'); process.exit(1); }

const MODEL = process.env.GEMINI_MODEL_ID || 'gemini-3-flash-preview';
const ai = new GoogleGenAI({ apiKey: API_KEY });

// ── Language Directive Builder ─────────────────────────────────────────
// This mirrors the proposed production implementation: appending a
// language directive onto the existing system instruction.
function buildSystemInstruction(botLanguage = null) {
    if (!botLanguage) {
        return CHAT_SAGE_SYSTEM_INSTRUCTION;
    }
    return `${CHAT_SAGE_SYSTEM_INSTRUCTION} You MUST respond entirely in ${botLanguage}.`;
}

// ── Simulated Stream Context ───────────────────────────────────────────
const STREAM_CONTEXT = buildContextPrompt({
    channelName: 'parfaittest',
    streamGame: 'The Legend of Zelda: Tears of the Kingdom',
    streamTitle: 'zelda totk first playthrough! no spoilers pls',
    streamTags: 'English, Chill, Zelda, FirstPlaythrough, Nintendo',
    chatSummary: 'Chat is watching a first playthrough of Tears of the Kingdom. The streamer just got the Ultrahand ability. Mood is chill.',
    recentChatHistory: [
        'velvetmoth: this game looks so beautiful',
        'neonpuddle: ultrahand is gonna change everything',
        'glitchfox: the music up here is incredible',
        'parfaittest: wait how do i get down from here lol',
    ].join('\n'),
});

// ── Test Messages ──────────────────────────────────────────────────────
// A focused subset covering different response types: casual chat,
// knowledge questions, and absurd/stress inputs.
const TEST_MESSAGES = [
    { label: 'Chat: Cozy comment',       user: 'velvetmoth',  message: 'this stream is so cozy tonight' },
    { label: 'Chat: New viewer',          user: 'glitchfox',   message: 'hey just got here whats going on' },
    { label: 'Cmd: Food question',        user: 'cosmictoast', message: 'what is shawarma' },
    { label: 'Cmd: Trivia',              user: 'glitchfox',   message: 'how many bones does a shark have' },
    { label: 'Chat: Life advice',         user: 'velvetmoth',  message: 'i want to quit my job and become a florist, is that stupid' },
    { label: 'Stress: Absurd',           user: 'neonpuddle',  message: 'climbs in your mouth' },
    { label: 'Chat: Hype',              user: 'cosmictoast', message: 'LETS GOOO that dodge was insane' },
    { label: 'Cmd: Tech question',       user: 'neonpuddle',  message: 'what is the difference between TCP and UDP' },
];

// ── Default Languages ──────────────────────────────────────────────────
const DEFAULT_LANGUAGES = [null, 'Spanish', 'Japanese'];

// ── Helpers ────────────────────────────────────────────────────────────

function checkViolations(text) {
    const issues = [];
    if (text.length > 450) issues.push(`over 450ch (${text.length})`);
    if (/\*\*/.test(text)) issues.push('contains **markdown**');
    if (/as an ai/i.test(text)) issues.push('says "as an AI"');
    return issues;
}

/**
 * Quick heuristic to check if a response contains characters from
 * the expected script/language. Not foolproof, but a useful signal.
 */
function checkLanguageCompliance(text, language) {
    if (!language) return { compliant: true, signal: 'English (default)' };

    const lang = language.toLowerCase();

    // Japanese: expect at least some CJK/Hiragana/Katakana
    if (lang === 'japanese') {
        const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(text);
        return { compliant: hasJapanese, signal: hasJapanese ? '✅ Contains Japanese chars' : '❌ No Japanese chars detected' };
    }

    // Chinese
    if (lang === 'chinese' || lang === 'mandarin') {
        const hasChinese = /[\u4E00-\u9FFF]/.test(text);
        return { compliant: hasChinese, signal: hasChinese ? '✅ Contains Chinese chars' : '❌ No Chinese chars detected' };
    }

    // Korean
    if (lang === 'korean') {
        const hasKorean = /[\uAC00-\uD7AF\u1100-\u11FF]/.test(text);
        return { compliant: hasKorean, signal: hasKorean ? '✅ Contains Korean chars' : '❌ No Korean chars detected' };
    }

    // Arabic
    if (lang === 'arabic') {
        const hasArabic = /[\u0600-\u06FF]/.test(text);
        return { compliant: hasArabic, signal: hasArabic ? '✅ Contains Arabic chars' : '❌ No Arabic chars detected' };
    }

    // Thai
    if (lang === 'thai') {
        const hasThai = /[\u0E00-\u0E7F]/.test(text);
        return { compliant: hasThai, signal: hasThai ? '✅ Contains Thai chars' : '❌ No Thai chars detected' };
    }

    // Russian
    if (lang === 'russian') {
        const hasCyrillic = /[\u0400-\u04FF]/.test(text);
        return { compliant: hasCyrillic, signal: hasCyrillic ? '✅ Contains Cyrillic chars' : '❌ No Cyrillic chars detected' };
    }

    // Latin-script languages (Spanish, French, German, Portuguese, Italian, etc.)
    // Check for absence of English-common words as a loose signal, plus presence
    // of diacritics or language-specific patterns.
    const latinLangs = ['spanish', 'french', 'german', 'portuguese', 'italian', 'dutch', 'polish', 'turkish', 'swedish', 'danish', 'norwegian', 'finnish', 'czech', 'hungarian', 'romanian'];
    if (latinLangs.includes(lang)) {
        // Check for diacritics or non-ASCII latin (á, ñ, ü, ç, etc.)
        const hasDiacritics = /[À-ÿĀ-žŁ-ſ]/.test(text);
        // Also check if the text starts with common English words (weak negative signal)
        const startsEnglish = /^(the|i|it|that|this|hey|oh|well|sure|yeah|yes|no|hi|lol)\b/i.test(text.trim());

        if (hasDiacritics) {
            return { compliant: true, signal: '✅ Contains diacritics — likely target language' };
        }
        if (!startsEnglish) {
            return { compliant: true, signal: '🔶 No diacritics, but doesn\'t start English — possibly compliant' };
        }
        return { compliant: false, signal: '❌ Looks like plain English — may not be in target language' };
    }

    return { compliant: true, signal: '⚪ No script check available for this language' };
}

// ── Runner ─────────────────────────────────────────────────────────────

async function runSingle(systemInstruction, testMsg) {
    const userPrompt = `${STREAM_CONTEXT}\n\nUSER: ${testMsg.user} says: ${testMsg.message}`;
    const start = Date.now();
    try {
        const result = await ai.models.generateContent({
            model: MODEL,
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            config: {
                systemInstruction: { parts: [{ text: systemInstruction }] },
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
    // Parse --lang flags
    const languages = [];
    for (let i = 0; i < process.argv.length; i++) {
        if (process.argv[i] === '--lang' && process.argv[i + 1]) {
            languages.push(process.argv[i + 1]);
            i++;
        }
    }
    const targetLanguages = languages.length > 0
        ? [null, ...languages]  // Always include English baseline
        : DEFAULT_LANGUAGES;

    console.log(`\n🌐 Botlang Native Language Test`);
    console.log(`   Model: ${MODEL}`);
    console.log(`   Languages: ${targetLanguages.map(l => l || 'English (default)').join(', ')}`);
    console.log(`   Messages: ${TEST_MESSAGES.length}`);
    console.log(`${'═'.repeat(70)}`);

    // Build system instructions for each language
    const configs = targetLanguages.map(lang => ({
        language: lang,
        label: lang || 'English (default)',
        systemInstruction: buildSystemInstruction(lang),
    }));

    // Fire all API calls in parallel
    const jobs = [];
    for (const testMsg of TEST_MESSAGES) {
        for (const config of configs) {
            jobs.push(
                runSingle(config.systemInstruction, testMsg).then(result => ({
                    language: config.label,
                    languageRaw: config.language,
                    testMsg,
                    result,
                }))
            );
        }
    }

    console.log(`\n⏳ Firing ${jobs.length} parallel requests...`);
    const settled = await Promise.all(jobs);

    // Organize results
    const resultsByMsg = new Map();
    for (const s of settled) {
        const key = s.testMsg.label;
        if (!resultsByMsg.has(key)) resultsByMsg.set(key, []);
        resultsByMsg.get(key).push(s);
    }

    // Summary trackers
    const langStats = {};
    for (const c of configs) {
        langStats[c.label] = { totalMs: 0, totalLen: 0, count: 0, compliant: 0, violations: 0 };
    }

    // Print results
    for (const testMsg of TEST_MESSAGES) {
        console.log(`\n${'─'.repeat(70)}`);
        console.log(`💬 [${testMsg.label}] ${testMsg.user}: "${testMsg.message}"`);
        console.log(`${'─'.repeat(70)}`);

        const results = resultsByMsg.get(testMsg.label) || [];
        for (const { language, languageRaw, result } of results) {
            const issues = result.ok ? checkViolations(result.text) : ['ERROR'];
            const compliance = result.ok ? checkLanguageCompliance(result.text, languageRaw) : { compliant: false, signal: 'ERROR' };

            const status = issues.length ? '⚠️' : '✅';
            console.log(`\n  🌐 ${language} (${result.ms}ms, ${result.len}ch):`);
            console.log(`     "${result.text}"`);
            console.log(`     Language: ${compliance.signal}`);
            if (issues.length) console.log(`     ${status} ${issues.join(', ')}`);

            // Track stats
            const stats = langStats[language];
            stats.totalMs += result.ms;
            stats.totalLen += result.len;
            stats.count++;
            if (compliance.compliant) stats.compliant++;
            if (issues.length) stats.violations++;
        }
    }

    // ── Aggregate Summary ──────────────────────────────────────────────
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`📊 SUMMARY`);
    console.log(`${'═'.repeat(70)}`);

    for (const config of configs) {
        const stats = langStats[config.label];
        const avgMs = stats.count ? Math.round(stats.totalMs / stats.count) : 0;
        const avgLen = stats.count ? Math.round(stats.totalLen / stats.count) : 0;
        const complianceRate = stats.count ? Math.round((stats.compliant / stats.count) * 100) : 0;

        console.log(`\n  ┌─ ${config.label}`);
        console.log(`  │  Avg latency: ${avgMs}ms | Avg length: ${avgLen}ch`);
        console.log(`  │  Language compliance: ${stats.compliant}/${stats.count} (${complianceRate}%)`);
        console.log(`  │  Violations: ${stats.violations}/${stats.count}`);
        if (config.language) {
            console.log(`  │  System instruction snippet: "...${config.systemInstruction.slice(-60)}"`);
        }
        console.log(`  └${'─'.repeat(50)}`);
    }

    // Final verdict
    console.log(`\n${'═'.repeat(70)}`);
    const nonEnglishConfigs = configs.filter(c => c.language !== null);
    const allCompliant = nonEnglishConfigs.every(c => {
        const stats = langStats[c.label];
        return stats.count > 0 && (stats.compliant / stats.count) >= 0.75;
    });

    if (allCompliant) {
        console.log(`✅ PASS — All non-English languages achieved ≥75% compliance rate.`);
        console.log(`   The system instruction approach works for native language generation.`);
    } else {
        console.log(`⚠️  MIXED — Some languages had <75% compliance. Review results above.`);
        for (const c of nonEnglishConfigs) {
            const stats = langStats[c.label];
            const rate = stats.count ? Math.round((stats.compliant / stats.count) * 100) : 0;
            if (rate < 75) {
                console.log(`   ❌ ${c.label}: ${rate}% compliance`);
            }
        }
    }
    console.log(`${'═'.repeat(70)}\n`);

    const anyErrors = settled.some(s => !s.result.ok);
    process.exit(anyErrors ? 1 : 0);
}

main();
