#!/usr/bin/env node
/**
 * scripts/benchmark-latency.js
 *
 * Comprehensive, high-precision latency benchmarking script comparing:
 *   - Gemini 3 Flash (gemini-3-flash-preview)
 *   - Gemini Flash Lite (gemini-flash-lite-latest)
 *   - GPT 5.6 Luna (gpt-5.6-luna)
 *
 * Measures Time-To-First-Token (TTFT), End-to-End Latency, Throughput (tokens/sec),
 * and cold-start vs warm performance across Daily Check-In, Translation, and General use cases.
 *
 * Usage:
 *   node scripts/benchmark-latency.js [options]
 *   npm run benchmark:latency -- [options]
 *
 * Options:
 *   --iterations <N>       Number of measured runs per test case (default: 5)
 *   --warmup <N>           Number of unmeasured warmup runs per test case (default: 1)
 *   --use-case <category>  Filter test cases: 'checkin', 'translation', 'general', or 'all' (default: 'all')
 *   --gemini3-model <id>   Override Gemini 3 model ID (default: gemini-3-flash-preview)
 *   --gemini-lite-model <id> Override Gemini Flash Lite model ID (default: gemini-flash-lite-latest)
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

const GEMINI_3_MODEL = getArg('--gemini3-model', process.env.GEMINI_MODEL_ID || 'gemini-3-flash-preview');
const GEMINI_LITE_MODEL = getArg('--gemini-lite-model', process.env.GEMINI_LITE_MODEL_ID || 'gemini-flash-lite-latest');
const OPENAI_MODEL = getArg('--openai-model', process.env.OPENAI_MODEL_ID || 'gpt-5.6-luna');

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

// Suppress SDK warning logs regarding thoughtSignature parts during benchmarks
const originalWarn = console.warn;
console.warn = function (...args) {
    if (typeof args[0] === 'string' && args[0].includes('thoughtSignature')) return;
    originalWarn.apply(console, args);
};

// ── Test Cases Definition ─────────────────────────────────────────────────────
const CHECKIN_SYSTEM = `You are a Twitch chat bot named WildcatSage. Respond to the prompt in a single short message suitable for Twitch chat. No markdown formatting. Be concise, warm, and match the tone requested. Keep response under 300 characters. If a check-in count is mentioned, refer to the viewer's cumulative check-ins.`;

const TRANSLATION_SYSTEM = `You are a real-time translation assistant for a Twitch stream. Translate the user input into the requested target language accurately, preserving Twitch emotes and gaming context. Output ONLY the translation. If input is already in target language, output "SAME_LANGUAGE".`;

const GENERAL_SYSTEM = `You are a helpful, fast, and concise AI assistant. Provide direct and accurate answers.`;

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
    },

    // ── General Use Cases ──
    {
        id: 'general_qa',
        category: 'general',
        name: 'General Q&A: TCP vs UDP Explanation',
        systemInstruction: GENERAL_SYSTEM,
        prompt: 'Explain the key difference between TCP and UDP networking protocols in exactly 2 concise sentences.',
        temperature: 0.7
    },
    {
        id: 'general_summarize',
        category: 'general',
        name: 'General Summarization: Stream Event Highlights',
        systemInstruction: GENERAL_SYSTEM,
        prompt: 'Summarize the following chat stream events into 2 concise bullet points:\n- Streamer started with a warm welcome and announced a sub goal.\n- The community played 3 rounds of Marbles on Stream.\n- The stream concluded with a friendly raid.',
        temperature: 0.5
    },
    {
        id: 'general_code_explain',
        category: 'general',
        name: 'General Code Explanation: JS Array Reduce',
        systemInstruction: GENERAL_SYSTEM,
        prompt: 'Explain what Array.prototype.reduce does in JavaScript in under 200 characters.',
        temperature: 0.3
    },
    {
        id: 'general_joke',
        category: 'general',
        name: 'General Creative: Gaming Banter',
        systemInstruction: GENERAL_SYSTEM,
        prompt: 'Tell a funny 1-liner joke about packet loss or lag in online games.',
        temperature: 1.0
    }
];

// ── Model Invocation Runners with Streaming & Precision Latency ────────────────

async function callGeminiStream(tc, modelId) {
    if (!aiClient) return null;

    const startTime = performance.now();
    let ttftMs = null;
    let text = '';
    let tokenCountEstimate = 0;

    try {
        const stream = await aiClient.models.generateContentStream({
            model: modelId,
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
        if (ttftMs === null) ttftMs = totalMs;
        if (!tokenCountEstimate) tokenCountEstimate = Math.ceil(text.length / 4);

        return {
            provider: 'Gemini',
            model: modelId,
            ttftMs,
            totalMs,
            charCount: text.length,
            tokenCount: tokenCountEstimate,
            tokensPerSec: totalMs > 0 ? (tokenCountEstimate / (totalMs / 1000)) : 0,
            text: text.trim()
        };
    } catch (err) {
        return { provider: 'Gemini', model: modelId, error: err.message };
    }
}

async function callOpenAiStream(tc) {
    if (!openaiClient) return null;

    const startTime = performance.now();
    let ttftMs = null;
    let text = '';
    let tokenCountEstimate = 0;

    try {
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
        console.log(`\n🚀 3-Model Latency Benchmark Suite: Gemini 3 Flash vs Gemini Flash Lite vs GPT 5.6 Luna`);
        console.log(`   Gemini 3 Flash:  ${GEMINI_KEY ? GEMINI_3_MODEL : '❌ (Missing API Key)'}`);
        console.log(`   Gemini Lite:     ${GEMINI_KEY ? GEMINI_LITE_MODEL : '❌ (Missing API Key)'}`);
        console.log(`   OpenAI Luna:     ${OPENAI_KEY ? OPENAI_MODEL : '❌ (Missing API Key)'}`);
        console.log(`   Iterations:      ${ITERATIONS} runs (+ ${WARMUP_RUNS} warmup)`);
        console.log(`   Filter:          ${USE_CASE_FILTER}\n`);
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
            console.log(`📋 Test Case: [${tc.category.toUpperCase()}] ${tc.name}`);
        }

        // --- Warmup Runs ---
        for (let w = 0; w < WARMUP_RUNS; w++) {
            if (aiClient) {
                await callGeminiStream(tc, GEMINI_3_MODEL);
                await callGeminiStream(tc, GEMINI_LITE_MODEL);
            }
            if (openaiClient) await callOpenAiStream(tc);
        }

        const gemini3Runs = [];
        const geminiLiteRuns = [];
        const openAiRuns = [];

        for (let i = 0; i < ITERATIONS; i++) {
            if (aiClient) {
                // Gemini 3 Flash
                const g3Res = await callGeminiStream(tc, GEMINI_3_MODEL);
                if (g3Res && !g3Res.error) {
                    gemini3Runs.push(g3Res);
                    if (VERBOSE && !JSON_ONLY) {
                        console.log(`   [Gemini 3 Run ${i + 1}] TTFT=${Math.round(g3Res.ttftMs)}ms Total=${Math.round(g3Res.totalMs)}ms`);
                    }
                }

                // Gemini Flash Lite
                const gLiteRes = await callGeminiStream(tc, GEMINI_LITE_MODEL);
                if (gLiteRes && !gLiteRes.error) {
                    geminiLiteRuns.push(gLiteRes);
                    if (VERBOSE && !JSON_ONLY) {
                        console.log(`   [Gemini Lite Run ${i + 1}] TTFT=${Math.round(gLiteRes.ttftMs)}ms Total=${Math.round(gLiteRes.totalMs)}ms`);
                    }
                }
            }

            if (openaiClient) {
                const oRes = await callOpenAiStream(tc);
                if (oRes && !oRes.error) {
                    openAiRuns.push(oRes);
                    if (VERBOSE && !JSON_ONLY) {
                        console.log(`   [OpenAI Run ${i + 1}] TTFT=${Math.round(oRes.ttftMs)}ms Total=${Math.round(oRes.totalMs)}ms`);
                    }
                }
            }
        }

        const g3Ttft = calculateStats(gemini3Runs.map(r => r.ttftMs));
        const g3Total = calculateStats(gemini3Runs.map(r => r.totalMs));
        const g3TokSec = calculateStats(gemini3Runs.map(r => r.tokensPerSec));

        const gLiteTtft = calculateStats(geminiLiteRuns.map(r => r.ttftMs));
        const gLiteTotal = calculateStats(geminiLiteRuns.map(r => r.totalMs));
        const gLiteTokSec = calculateStats(geminiLiteRuns.map(r => r.tokensPerSec));

        const oTtft = calculateStats(openAiRuns.map(r => r.ttftMs));
        const oTotal = calculateStats(openAiRuns.map(r => r.totalMs));
        const oTokSec = calculateStats(openAiRuns.map(r => r.tokensPerSec));

        const caseSummary = {
            id: tc.id,
            category: tc.category,
            name: tc.name,
            prompt: tc.prompt,
            gemini3: {
                model: GEMINI_3_MODEL,
                sampleCount: gemini3Runs.length,
                ttft: g3Ttft,
                totalLatency: g3Total,
                tokensPerSec: g3TokSec,
                sampleText: gemini3Runs[0]?.text || ''
            },
            geminiLite: {
                model: GEMINI_LITE_MODEL,
                sampleCount: geminiLiteRuns.length,
                ttft: gLiteTtft,
                totalLatency: gLiteTotal,
                tokensPerSec: gLiteTokSec,
                sampleText: geminiLiteRuns[0]?.text || ''
            },
            openai: {
                model: OPENAI_MODEL,
                sampleCount: openAiRuns.length,
                ttft: oTtft,
                totalLatency: oTotal,
                tokensPerSec: oTokSec,
                sampleText: openAiRuns[0]?.text || ''
            }
        };

        benchmarkResults.push(caseSummary);

        if (!JSON_ONLY) {
            if (aiClient) {
                console.log(`   ✨ Gemini 3 Flash | TTFT p50: ${g3Ttft.p50}ms (p90: ${g3Ttft.p90}ms) | Total p50: ${g3Total.p50}ms | Speed: ${g3TokSec.p50} tok/s`);
                console.log(`   ⚡ Gemini Lite    | TTFT p50: ${gLiteTtft.p50}ms (p90: ${gLiteTtft.p90}ms) | Total p50: ${gLiteTotal.p50}ms | Speed: ${gLiteTokSec.p50} tok/s`);
            }
            if (openaiClient) {
                console.log(`   🌙 OpenAI Luna   | TTFT p50: ${oTtft.p50}ms (p90: ${oTtft.p90}ms) | Total p50: ${oTotal.p50}ms | Speed: ${oTokSec.p50} tok/s`);
            }

            // Determine fastest TTFT model
            const ttftList = [
                { name: 'Gemini 3 Flash', ttft: g3Ttft.p50 },
                { name: 'Gemini Flash Lite', ttft: gLiteTtft.p50 },
                { name: 'GPT 5.6 Luna', ttft: oTtft.p50 }
            ].filter(m => m.ttft > 0).sort((a, b) => a.ttft - b.ttft);

            if (ttftList.length > 1) {
                const winner = ttftList[0];
                const runnerUp = ttftList[1];
                const diff = runnerUp.ttft - winner.ttft;
                console.log(`   🏆 Fast TTFT: ${winner.name} (${winner.ttft}ms, ${diff}ms faster than ${runnerUp.name})`);
            }
        }
    }

    // ── Global Aggregates & Output ─────────────────────────────────────────────
    const allG3Ttft = benchmarkResults.map(r => r.gemini3.ttft.p50).filter(v => v > 0);
    const allG3Total = benchmarkResults.map(r => r.gemini3.totalLatency.p50).filter(v => v > 0);
    const allGLiteTtft = benchmarkResults.map(r => r.geminiLite.ttft.p50).filter(v => v > 0);
    const allGLiteTotal = benchmarkResults.map(r => r.geminiLite.totalLatency.p50).filter(v => v > 0);
    const allOpenAiTtft = benchmarkResults.map(r => r.openai.ttft.p50).filter(v => v > 0);
    const allOpenAiTotal = benchmarkResults.map(r => r.openai.totalLatency.p50).filter(v => v > 0);

    const overall = {
        gemini3: {
            ttft: calculateStats(allG3Ttft),
            totalLatency: calculateStats(allG3Total)
        },
        geminiLite: {
            ttft: calculateStats(allGLiteTtft),
            totalLatency: calculateStats(allGLiteTotal)
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
            gemini3Model: GEMINI_3_MODEL,
            geminiLiteModel: GEMINI_LITE_MODEL,
            openaiModel: OPENAI_MODEL
        },
        overall,
        results: benchmarkResults
    };

    if (OUTPUT_FILE) {
        const resolvedPath = path.resolve(process.cwd(), OUTPUT_FILE);
        await fs.writeFile(resolvedPath, JSON.stringify(finalPayload, null, 2), 'utf-8');
        if (!JSON_ONLY) console.log(`\n💾 Saved detailed 3-model benchmark report to: ${resolvedPath}`);
    }

    if (JSON_ONLY) {
        console.log(JSON.stringify(finalPayload, null, 2));
    } else {
        console.log(`\n══════════════════════════════════════════════════════════════════════════`);
        console.log(`📊 3-MODEL OVERALL BENCHMARK SUMMARY (p50 Medians across all test cases)`);
        console.log(`══════════════════════════════════════════════════════════════════════════`);
        console.log(`   ✨ Gemini 3 Flash (${GEMINI_3_MODEL}):`);
        console.log(`     • TTFT p50:          ${overall.gemini3.ttft.p50} ms`);
        console.log(`     • End-to-End p50:    ${overall.gemini3.totalLatency.p50} ms`);
        console.log(`   ⚡ Gemini Flash Lite (${GEMINI_LITE_MODEL}):`);
        console.log(`     • TTFT p50:          ${overall.geminiLite.ttft.p50} ms`);
        console.log(`     • End-to-End p50:    ${overall.geminiLite.totalLatency.p50} ms`);
        console.log(`   🌙 GPT 5.6 Luna (${OPENAI_MODEL}):`);
        console.log(`     • TTFT p50:          ${overall.openai.ttft.p50} ms`);
        console.log(`     • End-to-End p50:    ${overall.openai.totalLatency.p50} ms`);
        console.log(`══════════════════════════════════════════════════════════════════════════\n`);
    }
}

main().catch(err => {
    console.error('❌ Benchmark execution failed:', err);
    process.exit(1);
});
