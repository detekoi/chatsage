#!/usr/bin/env node
/**
 * scripts/benchmark-latency.js
 *
 * Comprehensive, high-precision latency benchmarking script comparing:
 *   - Gemini Flash Lite (gemini-flash-lite-latest / gemini-2.5-flash-lite)
 *   - GPT 5.6 Luna (gpt-5.6-luna)
 *
 * Measures Time-To-First-Token (TTFT), End-to-End Latency, Throughput (tokens/sec),
 * and cold-start vs warm performance across Daily Check-In and Translation use cases.
 *
 * Usage:
 *   node scripts/benchmark-latency.js [options]
 *   npm run benchmark:latency -- [options]
 *
 * Options:
 *   --iterations <N>       Number of measured runs per test case (default: 5)
 *   --warmup <N>           Number of unmeasured warmup runs per test case (default: 1)
 *   --use-case <category>  Filter test cases: 'checkin', 'translation', or 'all' (default: 'all')
 *   --gemini-model <id>    Override Gemini model ID (default: gemini-flash-lite-latest)
 *   --openai-model <id>    Override OpenAI model ID (default: gpt-5.6-luna)
 *   --output <path>        Save detailed JSON results to file path
 *   --json                 Output final raw JSON to stdout instead of formatted table
 *   --verbose              Print full model outputs for each run
 */

import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { performance } from 'perf_hooks';
import fs from 'fs/promises';
import path from 'path';

// ── Parse Command Line Arguments ─────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag, defaultValue) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
    return defaultValue;
}
function hasFlag(flag) {
    return args.includes(flag);
}

const ITERATIONS = parseInt(getArg('--iterations', '5'), 10);
const WARMUP_RUNS = parseInt(getArg('--warmup', '1'), 10);
const USE_CASE_FILTER = getArg('--use-case', 'all').toLowerCase();
const GEMINI_MODEL = getArg('--gemini-model', process.env.GEMINI_LITE_MODEL_ID || 'gemini-flash-lite-latest');
const OPENAI_MODEL = getArg('--openai-model', process.env.OPENAI_LITE_MODEL_ID || 'gpt-5.6-luna');
const OUTPUT_FILE = getArg('--output', null);
const JSON_ONLY = hasFlag('--json');
const VERBOSE = hasFlag('--verbose');

// ── Environment Verification ──────────────────────────────────────────────────
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

if (!GEMINI_KEY && !OPENAI_KEY) {
    console.error('❌ Error: Missing both GEMINI_API_KEY and OPENAI_API_KEY in environment.');
    process.exit(1);
}

const aiClient = GEMINI_KEY ? new GoogleGenAI({ apiKey: GEMINI_KEY }) : null;
const openaiClient = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

// ── Test Cases Definition ─────────────────────────────────────────────────────
const CHECKIN_SYSTEM = `You are a Twitch chat bot named WildcatSage. Respond to the prompt in a single short message suitable for Twitch chat. No markdown formatting. Be concise, warm, and match the tone requested. Keep response under 300 characters. If a check-in count is mentioned, refer to the viewer's cumulative check-ins.`;

const TRANSLATION_SYSTEM = `You are a real-time translation assistant for a Twitch stream. Translate the user input into the requested target language accurately, preserving Twitch emotes and gaming context. Output ONLY the translation. If input is already in target language, output "SAME_LANGUAGE".`;

const TEST_CASES = [
    // ── Daily Check-In Use Cases ──
    {
        id: 'checkin_newcomer',
        category: 'checkin',
        name: 'Daily Check-In: Newcomer (1st check-in)',
        systemInstruction: CHECKIN_SYSTEM,
        prompt: `Note that @idzuna just checked in for time #1. React with quiet warmth and welcome them to the stream!`,
        temperature: 1.2
    },
    {
        id: 'checkin_regular',
        category: 'checkin',
        name: 'Daily Check-In: Regular (42nd check-in)',
        systemInstruction: CHECKIN_SYSTEM,
        prompt: `Note that @parfaitfair just checked in for time #42. React with quiet warmth and a touch of wit, like someone who genuinely notices the regulars.`,
        temperature: 1.2
    },
    {
        id: 'checkin_milestone',
        category: 'checkin',
        name: 'Daily Check-In: Milestone (100th check-in)',
        systemInstruction: CHECKIN_SYSTEM,
        prompt: `Note that @turboicehusky just checked in for time #100! Celebrate this major milestone with excitement and genuine gratitude.`,
        temperature: 1.3
    },

    // ── Translation Use Cases ──
    {
        id: 'trans_en_ja',
        category: 'translation',
        name: 'Translation: English -> Japanese',
        systemInstruction: TRANSLATION_SYSTEM,
        prompt: `Target language: Japanese\nText to translate: "Good luck on the boss fight, you got this!"`,
        temperature: 0.2
    },
    {
        id: 'trans_ja_en',
        category: 'translation',
        name: 'Translation: Japanese -> English',
        systemInstruction: TRANSLATION_SYSTEM,
        prompt: `Target language: English\nText to translate: "今日は配信ありがとうございます！応援しています"`,
        temperature: 0.2
    },
    {
        id: 'trans_en_es',
        category: 'translation',
        name: 'Translation: English -> Spanish',
        systemInstruction: TRANSLATION_SYSTEM,
        prompt: `Target language: Spanish\nText to translate: "Hello everyone in twitch chat! Hope you are having a wonderful stream."`,
        temperature: 0.2
    },
    {
        id: 'trans_slang',
        category: 'translation',
        name: 'Translation: Twitch Chat Slang / Emotes',
        systemInstruction: TRANSLATION_SYSTEM,
        prompt: `Target language: Japanese\nText to translate: "LFG let's go chat gg!"`,
        temperature: 0.2
    },
    {
        id: 'trans_same_lang',
        category: 'translation',
        name: 'Translation: Same-Language Detection',
        systemInstruction: TRANSLATION_SYSTEM,
        prompt: `Target language: Spanish\nText to translate: "Buenas noches a todos"`,
        temperature: 0.2
    }
];

// Suppress SDK warning logs regarding thoughtSignature parts during benchmarks
const originalWarn = console.warn;
console.warn = function (...args) {
    if (typeof args[0] === 'string' && args[0].includes('thoughtSignature')) return;
    originalWarn.apply(console, args);
};

// ── Model Invocation Runners with Streaming & Precision Latency ────────────────

async function callGeminiStream(tc) {
    if (!aiClient) return null;

    const startTime = performance.now();
    let ttftMs = null;
    let text = '';
    let tokenCountEstimate = 0;

    try {
        const stream = await aiClient.models.generateContentStream({
            model: GEMINI_MODEL,
            contents: [{ role: 'user', parts: [{ text: tc.prompt }] }],
            config: {
                systemInstruction: tc.systemInstruction ? { parts: [{ text: tc.systemInstruction }] } : undefined,
                temperature: tc.temperature || 1.0,
            }
        });

        for await (const chunk of stream) {
            let chunkText = '';
            const parts = chunk.candidates?.[0]?.content?.parts;
            if (parts && Array.isArray(parts)) {
                for (const p of parts) {
                    if (p.text) chunkText += p.text;
                }
            } else if (typeof chunk.text === 'string') {
                chunkText = chunk.text;
            }

            if (chunkText.length > 0) {
                if (ttftMs === null) {
                    ttftMs = performance.now() - startTime;
                }
                text += chunkText;
            }
            if (chunk.usageMetadata?.candidatesTokenCount) {
                tokenCountEstimate = chunk.usageMetadata.candidatesTokenCount;
            }
        }

        const totalMs = performance.now() - startTime;
        if (ttftMs === null) ttftMs = totalMs; // Fallback if single non-chunk response
        if (!tokenCountEstimate) tokenCountEstimate = Math.ceil(text.length / 4);

        return {
            provider: 'Gemini',
            model: GEMINI_MODEL,
            ttftMs,
            totalMs,
            charCount: text.length,
            tokenCount: tokenCountEstimate,
            tokensPerSec: totalMs > 0 ? (tokenCountEstimate / (totalMs / 1000)) : 0,
            text: text.trim()
        };
    } catch (err) {
        return { provider: 'Gemini', model: GEMINI_MODEL, error: err.message };
    }
}

async function callOpenAiStream(tc) {
    if (!openaiClient) return null;

    const startTime = performance.now();
    let ttftMs = null;
    let text = '';
    let tokenCountEstimate = 0;

    try {
        // Primary API: responses.create streaming
        try {
            const stream = await openaiClient.responses.create({
                model: OPENAI_MODEL,
                input: tc.prompt,
                instructions: tc.systemInstruction,
                stream: true
            });

            for await (const chunk of stream) {
                let delta = '';
                if (chunk.type === 'response.output_text.delta') {
                    delta = chunk.delta || '';
                } else if (chunk.type === 'response.text.delta') {
                    delta = chunk.delta || '';
                }
                if (delta.length > 0) {
                    if (ttftMs === null) {
                        ttftMs = performance.now() - startTime;
                    }
                    text += delta;
                }
                if (chunk.response?.usage?.output_tokens) {
                    tokenCountEstimate = chunk.response.usage.output_tokens;
                }
            }
        } catch (respErr) {
            // Fallback API: chat.completions.create streaming
            const messages = [];
            if (tc.systemInstruction) messages.push({ role: 'system', content: tc.systemInstruction });
            messages.push({ role: 'user', content: tc.prompt });

            const stream = await openaiClient.chat.completions.create({
                model: OPENAI_MODEL,
                messages,
                stream: true
            });

            for await (const chunk of stream) {
                const delta = chunk.choices[0]?.delta?.content || '';
                if (delta.length > 0) {
                    if (ttftMs === null) {
                        ttftMs = performance.now() - startTime;
                    }
                    text += delta;
                }
            }
        }

        const totalMs = performance.now() - startTime;
        if (ttftMs === null) ttftMs = totalMs;
        if (!tokenCountEstimate) tokenCountEstimate = Math.ceil(text.length / 4);

        return {
            provider: 'OpenAI',
            model: OPENAI_MODEL,
            ttftMs,
            totalMs,
            charCount: text.length,
            tokenCount: tokenCountEstimate,
            tokensPerSec: totalMs > 0 ? (tokenCountEstimate / (totalMs / 1000)) : 0,
            text: text.trim()
        };
    } catch (err) {
        return { provider: 'OpenAI', model: OPENAI_MODEL, error: err.message };
    }
}

// ── Statistical Helper Functions ──────────────────────────────────────────────
function calculateStats(values) {
    if (!values || values.length === 0) {
        return { p50: 0, p90: 0, p95: 0, p99: 0, mean: 0, min: 0, max: 0, stddev: 0 };
    }
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;

    const percentile = (p) => {
        const index = (p / 100) * (n - 1);
        const lower = Math.floor(index);
        const upper = Math.ceil(index);
        const weight = index - lower;
        if (upper >= n) return sorted[n - 1];
        return sorted[lower] * (1 - weight) + sorted[upper] * weight;
    };

    const mean = values.reduce((sum, v) => sum + v, 0) / n;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / n;
    const stddev = Math.sqrt(variance);

    return {
        p50: Math.round(percentile(50)),
        p90: Math.round(percentile(90)),
        p95: Math.round(percentile(95)),
        p99: Math.round(percentile(99)),
        mean: Math.round(mean),
        min: Math.round(sorted[0]),
        max: Math.round(sorted[n - 1]),
        stddev: Math.round(stddev)
    };
}

// ── Main Execution Workflow ──────────────────────────────────────────────────
async function main() {
    if (!JSON_ONLY) {
        console.log(`\n🚀 Latency Benchmark Suite: Gemini Flash Lite vs GPT 5.6 Luna`);
        console.log(`   Gemini Model: ${GEMINI_KEY ? GEMINI_MODEL : '❌ (Missing API Key)'}`);
        console.log(`   OpenAI Model: ${OPENAI_KEY ? OPENAI_MODEL : '❌ (Missing API Key)'}`);
        console.log(`   Iterations:   ${ITERATIONS} runs (+ ${WARMUP_RUNS} warmup)`);
        console.log(`   Filter:       ${USE_CASE_FILTER}\n`);
    }

    const activeCases = TEST_CASES.filter(tc => {
        if (USE_CASE_FILTER === 'all') return true;
        return tc.category === USE_CASE_FILTER;
    });

    if (activeCases.length === 0) {
        console.error(`❌ No test cases found matching --use-case ${USE_CASE_FILTER}`);
        process.exit(1);
    }

    const benchmarkResults = [];

    for (const tc of activeCases) {
        if (!JSON_ONLY) {
            console.log(`──────────────────────────────────────────────────────────────────────────`);
            console.log(`📋 Test Case: ${tc.name}`);
        }

        // --- Warmup Runs ---
        for (let w = 0; w < WARMUP_RUNS; w++) {
            if (aiClient) await callGeminiStream(tc);
            if (openaiClient) await callOpenAiStream(tc);
        }

        const geminiRuns = [];
        const openAiRuns = [];

        for (let i = 0; i < ITERATIONS; i++) {
            if (aiClient) {
                const gRes = await callGeminiStream(tc);
                if (gRes && !gRes.error) {
                    geminiRuns.push(gRes);
                    if (VERBOSE && !JSON_ONLY) {
                        console.log(`   [Gemini Run ${i + 1}] TTFT=${Math.round(gRes.ttftMs)}ms Total=${Math.round(gRes.totalMs)}ms Text="${gRes.text}"`);
                    }
                } else if (gRes?.error && !JSON_ONLY) {
                    console.log(`   ⚠️ Gemini error (Run ${i + 1}): ${gRes.error}`);
                }
            }

            if (openaiClient) {
                const oRes = await callOpenAiStream(tc);
                if (oRes && !oRes.error) {
                    openAiRuns.push(oRes);
                    if (VERBOSE && !JSON_ONLY) {
                        console.log(`   [OpenAI Run ${i + 1}] TTFT=${Math.round(oRes.ttftMs)}ms Total=${Math.round(oRes.totalMs)}ms Text="${oRes.text}"`);
                    }
                } else if (oRes?.error && !JSON_ONLY) {
                    console.log(`   ⚠️ OpenAI error (Run ${i + 1}): ${oRes.error}`);
                }
            }
        }

        const gTtftStats = calculateStats(geminiRuns.map(r => r.ttftMs));
        const gTotalStats = calculateStats(geminiRuns.map(r => r.totalMs));
        const gTokensSec = calculateStats(geminiRuns.map(r => r.tokensPerSec));

        const oTtftStats = calculateStats(openAiRuns.map(r => r.ttftMs));
        const oTotalStats = calculateStats(openAiRuns.map(r => r.totalMs));
        const oTokensSec = calculateStats(openAiRuns.map(r => r.tokensPerSec));

        const caseSummary = {
            id: tc.id,
            category: tc.category,
            name: tc.name,
            prompt: tc.prompt,
            gemini: {
                model: GEMINI_MODEL,
                sampleCount: geminiRuns.length,
                ttft: gTtftStats,
                totalLatency: gTotalStats,
                tokensPerSec: gTokensSec,
                sampleText: geminiRuns[0]?.text || ''
            },
            openai: {
                model: OPENAI_MODEL,
                sampleCount: openAiRuns.length,
                ttft: oTtftStats,
                totalLatency: oTotalStats,
                tokensPerSec: oTokensSec,
                sampleText: openAiRuns[0]?.text || ''
            }
        };

        benchmarkResults.push(caseSummary);

        if (!JSON_ONLY) {
            if (aiClient) {
                console.log(`   ⚡ Gemini  | TTFT p50: ${gTtftStats.p50}ms (p90: ${gTtftStats.p90}ms) | Total p50: ${gTotalStats.p50}ms (p90: ${gTotalStats.p90}ms) | Speed: ${gTokensSec.p50} tok/s`);
            }
            if (openaiClient) {
                console.log(`   🌙 OpenAI  | TTFT p50: ${oTtftStats.p50}ms (p90: ${oTtftStats.p90}ms) | Total p50: ${oTotalStats.p50}ms (p90: ${oTotalStats.p90}ms) | Speed: ${oTokensSec.p50} tok/s`);
            }

            if (aiClient && openaiClient && gTtftStats.p50 > 0 && oTtftStats.p50 > 0) {
                const ttftDiff = oTtftStats.p50 - gTtftStats.p50;
                const ttftFasterPct = Math.abs(Math.round((ttftDiff / oTtftStats.p50) * 100));
                const totalDiff = oTotalStats.p50 - gTotalStats.p50;
                const totalFasterPct = Math.abs(Math.round((totalDiff / oTotalStats.p50) * 100));

                if (ttftDiff > 0) {
                    console.log(`   🏆 Winner (TTFT): Gemini Flash Lite is ${Math.abs(ttftDiff)}ms (${ttftFasterPct}%) FASTER`);
                } else if (ttftDiff < 0) {
                    console.log(`   🏆 Winner (TTFT): GPT 5.6 Luna is ${Math.abs(ttftDiff)}ms (${ttftFasterPct}%) FASTER`);
                } else {
                    console.log(`   🏆 Winner (TTFT): TIE`);
                }
            }
        }
    }

    // ── Global Aggregates & Output ─────────────────────────────────────────────
    const allGeminiTtft = benchmarkResults.map(r => r.gemini.ttft.p50).filter(v => v > 0);
    const allGeminiTotal = benchmarkResults.map(r => r.gemini.totalLatency.p50).filter(v => v > 0);
    const allOpenAiTtft = benchmarkResults.map(r => r.openai.ttft.p50).filter(v => v > 0);
    const allOpenAiTotal = benchmarkResults.map(r => r.openai.totalLatency.p50).filter(v => v > 0);

    const overall = {
        gemini: {
            ttft: calculateStats(allGeminiTtft),
            totalLatency: calculateStats(allGeminiTotal)
        },
        openai: {
            ttft: calculateStats(allOpenAiTtft),
            totalLatency: calculateStats(allOpenAiTotal)
        }
    };

    const finalPayload = {
        timestamp: new Date().toISOString(),
        config: {
            iterations: ITERATIONS,
            warmupRuns: WARMUP_RUNS,
            useCaseFilter: USE_CASE_FILTER,
            geminiModel: GEMINI_MODEL,
            openaiModel: OPENAI_MODEL
        },
        overall,
        results: benchmarkResults
    };

    if (OUTPUT_FILE) {
        const resolvedPath = path.resolve(process.cwd(), OUTPUT_FILE);
        await fs.writeFile(resolvedPath, JSON.stringify(finalPayload, null, 2), 'utf-8');
        if (!JSON_ONLY) console.log(`\n💾 Saved detailed benchmark report to: ${resolvedPath}`);
    }

    if (JSON_ONLY) {
        console.log(JSON.stringify(finalPayload, null, 2));
    } else {
        console.log(`\n══════════════════════════════════════════════════════════════════════════`);
        console.log(`📊 OVERALL BENCHMARK SUMMARY (p50 Medians across all test cases)`);
        console.log(`══════════════════════════════════════════════════════════════════════════`);
        console.log(`   Gemini Flash Lite (${GEMINI_MODEL}):`);
        console.log(`     • TTFT p50:          ${overall.gemini.ttft.p50} ms`);
        console.log(`     • End-to-End p50:    ${overall.gemini.totalLatency.p50} ms`);
        console.log(`   GPT 5.6 Luna (${OPENAI_MODEL}):`);
        console.log(`     • TTFT p50:          ${overall.openai.ttft.p50} ms`);
        console.log(`     • End-to-End p50:    ${overall.openai.totalLatency.p50} ms`);

        if (overall.gemini.ttft.p50 > 0 && overall.openai.ttft.p50 > 0) {
            const ttftDiff = overall.openai.ttft.p50 - overall.gemini.ttft.p50;
            const ttftPct = Math.abs(Math.round((ttftDiff / overall.openai.ttft.p50) * 100));
            const totalDiff = overall.openai.totalLatency.p50 - overall.gemini.totalLatency.p50;
            const totalPct = Math.abs(Math.round((totalDiff / overall.openai.totalLatency.p50) * 100));

            console.log(`──────────────────────────────────────────────────────────────────────────`);
            console.log(`🏆 OVERALL SUMMARY COMPARISON:`);
            console.log(`   • TTFT:    Gemini Flash Lite is ${ttftDiff > 0 ? `${ttftDiff}ms (${ttftPct}%) FASTER` : `${Math.abs(ttftDiff)}ms SLOWER`} than GPT 5.6 Luna`);
            console.log(`   • E2E:     Gemini Flash Lite is ${totalDiff > 0 ? `${totalDiff}ms (${totalPct}%) FASTER` : `${Math.abs(totalDiff)}ms SLOWER`} than GPT 5.6 Luna`);
        }
        console.log(`══════════════════════════════════════════════════════════════════════════\n`);
    }
}

main().catch(err => {
    console.error('❌ Benchmark execution failed:', err);
    process.exit(1);
});
