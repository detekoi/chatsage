#!/usr/bin/env node
/**
 * scripts/benchmark-flex-processing.js
 *
 * Multi-Provider Benchmark Suite comparing Standard Processing (default/auto)
 * vs Flex Processing (service_tier: "flex") across Gemini & OpenAI models.
 *
 * Default Models Tested:
 *   - Gemini Flash Lite  (gemini-flash-lite-latest) - Used by bot for chat summaries & lite tasks
 *   - Gemini 3 Flash     (gemini-3-flash-preview)
 *   - GPT 5.6 Luna       (gpt-5.6-luna)              - OpenAI primary model
 *
 * Workload Categories (Non-synchronous / background / pre-cached):
 *   - Ad Notifications (cached 60s before ad run)
 *   - Chat Lull Auto-Chat (asynchronous prompt during chat silence)
 *   - Stream Recap & Background Prefetch (low-priority status summaries)
 *   - Chat Summary (asynchronous chat activity summarization)
 *
 * Usage:
 *   node scripts/benchmark-flex-processing.js [options]
 *   npm run benchmark:flex -- [options]
 *
 * Options:
 *   --iterations <N>            Number of measured runs per test case (default: 5)
 *   --warmup <N>                Number of unmeasured warmup runs per test case (default: 1)
 *   --use-case <ad|lull|recap|summary|all> Filter test cases (default: 'all')
 *   --provider <both|gemini|openai> Select LLM provider (default: 'both')
 *   --gemini-lite-model <id>    Override Gemini Flash Lite model ID (default: gemini-flash-lite-latest)
 *   --gemini3-model <id>        Override Gemini 3 Flash model ID (default: gemini-3-flash-preview)
 *   --openai-model <id>         Override OpenAI model ID (default: gpt-5.6-luna)
 *   --timeout <ms>              Max request timeout in ms (default: 900000 / 15m)
 *   --fallback-on-unavailable   Test fallback to standard processing on 429 / 503
 *   --output <path>             Save detailed JSON results to file path
 *   --json                      Output raw JSON to stdout
 *   --verbose                   Print full model outputs for each run
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
const PROVIDER_FILTER = getArg('--provider', 'both').toLowerCase();

const GEMINI_LITE_MODEL = getArg('--gemini-lite-model', process.env.GEMINI_LITE_MODEL_ID || 'gemini-flash-lite-latest');
const OPENAI_MODEL = getArg('--openai-model', process.env.OPENAI_MODEL_ID || 'gpt-5.6-luna');

const TIMEOUT_MS = parseInt(getArg('--timeout', '900000'), 10); // 15 mins
const FALLBACK_ON_UNAVAILABLE = hasFlag('--fallback-on-unavailable');
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
const openaiClient = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY, timeout: TIMEOUT_MS }) : null;

// ── Non-Synchronous Workload Test Cases ───────────────────────────────────────
const TEST_CASES = [
    {
        id: 'ad_notification_cached',
        category: 'ad',
        name: 'Ad Notification (Pre-cached 60s ahead)',
        systemInstruction: 'You are a Twitch chat bot generating a scheduled ad break reminder. Keep it friendly, short, and under 250 characters. Remind chat to grab water/snacks.',
        prompt: 'Notice: A 90-second ad break will run in exactly 60 seconds. Generate a warm, stream-appropriate warning announcement for chat.',
        temperature: 0.7
    },
    {
        id: 'chat_lull_autochat',
        category: 'lull',
        name: 'Chat Lull Auto-Chat (Asynchronous spark prompt)',
        systemInstruction: 'You are WildcatSage, an AI Twitch bot. Respond to stream context when chat has been quiet. One sentence. <= 25 words. Relaxed, confident. No meta about the lull.',
        prompt: 'Chat has been quiet for 5 minutes during a gaming stream. Generate a natural conversation-starter for chat.',
        temperature: 0.8
    },
    {
        id: 'stream_recap_prefetch',
        category: 'recap',
        name: 'Stream Recap & Background Prefetch',
        systemInstruction: 'You are WildcatSage generating a background stream recap summary for stream overlays or discord notifications. 2 concise sentences.',
        prompt: 'Stream summary data: 14 new followers, 4 sub renewals, peak viewers: 240, playing Elden Ring Nightreign. Summarize progress for background notification.',
        temperature: 0.5
    },
    {
        id: 'chat_summary_flex',
        category: 'summary',
        name: 'Chat Summary (Asynchronous chat summarization - Gemini Flash Lite)',
        systemInstruction: 'You are an AI assistant producing a structured summary of recent Twitch chat activity for stream analytics.',
        prompt: 'Chat log transcript (100 messages): [User1: Hype! User2: GG WP! User3: What build is that? User4: boss is hard! User5: LUL]. Summarize viewer sentiment, key topics, and questions asked in 3 bullet points.',
        temperature: 0.3
    }
];

// ── Statistics Helper ────────────────────────────────────────────────────────
function calculateStats(numbers) {
    if (!numbers || numbers.length === 0) {
        return { count: 0, min: 0, max: 0, avg: 0, p50: 0, p90: 0 };
    }
    const sorted = [...numbers].sort((a, b) => a - b);
    const count = sorted.length;
    const min = Math.round(sorted[0]);
    const max = Math.round(sorted[count - 1]);
    const sum = sorted.reduce((acc, val) => acc + val, 0);
    const avg = Math.round(sum / count);

    const getPercentile = (p) => {
        const index = Math.ceil((p / 100) * count) - 1;
        return Math.round(sorted[Math.max(0, index)]);
    };

    return {
        count,
        min,
        max,
        avg,
        p50: getPercentile(50),
        p90: getPercentile(90)
    };
}

// ── OpenAI Streaming Runner ──────────────────────────────────────────────────
async function callOpenAiFlexOrStandard(testCase, serviceTier, enableFallback = false) {
    if (!openaiClient) return { error: 'NO_OPENAI_KEY' };

    const startTime = performance.now();
    let ttftMs = 0;
    let totalMs = 0;
    let text = '';
    let isFallbackTriggered = false;
    let errorCode = null;
    let isResourceUnavailable = false;

    const payload = {
        model: OPENAI_MODEL,
        instructions: testCase.systemInstruction,
        input: testCase.prompt,
        service_tier: serviceTier,
        stream: true
    };

    const makeCall = async (tierToUse) => {
        const callPayload = { ...payload, service_tier: tierToUse };
        const stream = await openaiClient.responses.create(callPayload, { timeout: TIMEOUT_MS });

        let localText = '';
        let localTtft = 0;

        for await (const chunk of stream) {
            if (!localTtft) localTtft = performance.now() - startTime;
            if (chunk.output_text_delta) {
                localText += chunk.output_text_delta;
            } else if (chunk.type === 'response.output_text.delta') {
                localText += chunk.delta || '';
            }
        }
        return { localTtft, localText };
    };

    try {
        const result = await makeCall(serviceTier);
        ttftMs = result.localTtft || (performance.now() - startTime);
        text = result.localText;
        totalMs = performance.now() - startTime;
    } catch (err) {
        errorCode = err.status || err.code || 'UNKNOWN_ERROR';
        isResourceUnavailable = err.status === 429 || (err.message && err.message.includes('Resource Unavailable'));

        if (isResourceUnavailable && enableFallback && serviceTier === 'flex') {
            isFallbackTriggered = true;
            if (VERBOSE && !JSON_ONLY) {
                console.log(`   ⚠️ [OpenAI] Flex tier 429 Resource Unavailable - Retrying with standard tier...`);
            }
            try {
                const fbResult = await makeCall('auto');
                ttftMs = fbResult.localTtft || (performance.now() - startTime);
                text = fbResult.localText;
                totalMs = performance.now() - startTime;
                errorCode = null;
            } catch (fbErr) {
                totalMs = performance.now() - startTime;
                errorCode = fbErr.status || fbErr.code || 'FALLBACK_FAILED';
            }
        } else {
            totalMs = performance.now() - startTime;
        }
    }

    const tokenEstimate = Math.ceil(text.length / 4);
    const tokensPerSec = totalMs > 0 ? parseFloat(((tokenEstimate / totalMs) * 1000).toFixed(2)) : 0;

    return {
        provider: 'OpenAI',
        model: OPENAI_MODEL,
        serviceTier,
        ttftMs: Math.round(ttftMs),
        totalMs: Math.round(totalMs),
        tokensPerSec,
        text,
        error: errorCode,
        isResourceUnavailable,
        isFallbackTriggered
    };
}

// ── Gemini Streaming Runner ──────────────────────────────────────────────────
async function callGeminiFlexOrStandard(testCase, modelId, serviceTier, enableFallback = false) {
    if (!aiClient) return { error: 'NO_GEMINI_KEY' };

    const startTime = performance.now();
    let ttftMs = 0;
    let totalMs = 0;
    let text = '';
    let isFallbackTriggered = false;
    let errorCode = null;
    let isResourceUnavailable = false;

    const makeCall = async (tierToUse) => {
        const streamConfig = {
            systemInstruction: testCase.systemInstruction ? { parts: [{ text: testCase.systemInstruction }] } : undefined,
            temperature: testCase.temperature || 0.7,
            httpOptions: { timeout: TIMEOUT_MS }
        };
        if (tierToUse && tierToUse !== 'auto') {
            streamConfig.serviceTier = tierToUse;
        }

        const stream = await aiClient.models.generateContentStream({
            model: modelId,
            contents: [{ role: 'user', parts: [{ text: testCase.prompt }] }],
            config: streamConfig
        });

        let localText = '';
        let localTtft = 0;

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
                if (!localTtft) localTtft = performance.now() - startTime;
                localText += chunkText;
            }
        }
        return { localTtft, localText };
    };

    try {
        const result = await makeCall(serviceTier);
        ttftMs = result.localTtft || (performance.now() - startTime);
        text = result.localText;
        totalMs = performance.now() - startTime;
    } catch (err) {
        errorCode = err.status || err.code || 'UNKNOWN_ERROR';
        isResourceUnavailable = err.status === 503 || err.status === 429 || (err.message && (err.message.includes('Service Unavailable') || err.message.includes('Resource Unavailable')));

        if (isResourceUnavailable && enableFallback && serviceTier === 'flex') {
            isFallbackTriggered = true;
            if (VERBOSE && !JSON_ONLY) {
                console.log(`   ⚠️ [Gemini ${modelId}] Flex tier busy (${errorCode}) - Retrying with standard tier...`);
            }
            try {
                const fbResult = await makeCall('auto');
                ttftMs = fbResult.localTtft || (performance.now() - startTime);
                text = fbResult.localText;
                totalMs = performance.now() - startTime;
                errorCode = null;
            } catch (fbErr) {
                totalMs = performance.now() - startTime;
                errorCode = fbErr.status || fbErr.code || 'FALLBACK_FAILED';
            }
        } else {
            totalMs = performance.now() - startTime;
        }
    }

    const tokenEstimate = Math.ceil(text.length / 4);
    const tokensPerSec = totalMs > 0 ? parseFloat(((tokenEstimate / totalMs) * 1000).toFixed(2)) : 0;

    return {
        provider: 'Gemini',
        model: modelId,
        serviceTier,
        ttftMs: Math.round(ttftMs),
        totalMs: Math.round(totalMs),
        tokensPerSec,
        text,
        error: errorCode,
        isResourceUnavailable,
        isFallbackTriggered
    };
}

// ── Main Benchmark Execution ─────────────────────────────────────────────────
async function runBenchmark() {
    const activeCases = TEST_CASES.filter(tc => {
        if (USE_CASE_FILTER === 'all') return true;
        return tc.category.toLowerCase() === USE_CASE_FILTER;
    });

    if (activeCases.length === 0) {
        console.error(`❌ No test cases found matching --use-case "${USE_CASE_FILTER}"`);
        process.exit(1);
    }

    const testGemini = aiClient && (PROVIDER_FILTER === 'both' || PROVIDER_FILTER === 'gemini');
    const testOpenAi = openaiClient && (PROVIDER_FILTER === 'both' || PROVIDER_FILTER === 'openai');

    if (!testGemini && !testOpenAi) {
        console.error(`❌ No valid provider enabled for --provider "${PROVIDER_FILTER}". Check API keys in environment.`);
        process.exit(1);
    }

    if (!JSON_ONLY) {
        console.log(`\n🚀 Multi-Model Benchmark: Standard Processing vs Flex Processing (service_tier: flex)`);
        console.log(`   Gemini Lite Model:     ${testGemini ? GEMINI_LITE_MODEL : '❌ (Disabled)'}`);
        console.log(`   OpenAI Luna Model:     ${testOpenAi ? OPENAI_MODEL : '❌ (Disabled)'}`);
        console.log(`   Iterations per tier:   ${ITERATIONS} (Warmup: ${WARMUP_RUNS})`);
        console.log(`   Timeout:               ${TIMEOUT_MS}ms (${Math.round(TIMEOUT_MS / 60000)} mins)`);
        console.log(`   Fallback on 429/503:   ${FALLBACK_ON_UNAVAILABLE ? 'ENABLED' : 'DISABLED'}`);
        console.log(`   Test Cases Filter:     ${USE_CASE_FILTER.toUpperCase()} (${activeCases.length} cases)\n`);
    }

    const benchmarkResults = [];

    for (const tc of activeCases) {
        if (!JSON_ONLY) {
            console.log(`──────────────────────────────────────────────────────────────────────────`);
            console.log(`📋 Test Case: [${tc.category.toUpperCase()}] ${tc.name}`);
        }

        const modelsToTest = [];
        if (testGemini) {
            modelsToTest.push({ label: `Gemini Lite (${GEMINI_LITE_MODEL})`, provider: 'gemini', modelId: GEMINI_LITE_MODEL });
        }
        if (testOpenAi) {
            modelsToTest.push({ label: `GPT 5.6 Luna (${OPENAI_MODEL})`, provider: 'openai', modelId: OPENAI_MODEL });
        }

        const caseResult = {
            id: tc.id,
            category: tc.category,
            name: tc.name,
            prompt: tc.prompt,
            models: {}
        };

        for (const mObj of modelsToTest) {
            // Warmup
            for (let w = 0; w < WARMUP_RUNS; w++) {
                if (mObj.provider === 'gemini') {
                    await callGeminiFlexOrStandard(tc, mObj.modelId, 'auto', false);
                    await callGeminiFlexOrStandard(tc, mObj.modelId, 'flex', false);
                } else {
                    await callOpenAiFlexOrStandard(tc, 'auto', false);
                    await callOpenAiFlexOrStandard(tc, 'flex', false);
                }
            }

            const stdRuns = [];
            const flexRuns = [];

            for (let i = 0; i < ITERATIONS; i++) {
                const runner = (tier, fb) => mObj.provider === 'gemini'
                    ? callGeminiFlexOrStandard(tc, mObj.modelId, tier, fb)
                    : callOpenAiFlexOrStandard(tc, tier, fb);

                const stdRes = await runner('auto', false);
                if (!stdRes.error) stdRuns.push(stdRes);

                const flexRes = await runner('flex', FALLBACK_ON_UNAVAILABLE);
                flexRuns.push(flexRes);

                if (VERBOSE && !JSON_ONLY) {
                    console.log(`   [${mObj.label} - Iter ${i + 1}] Std Total=${stdRes.totalMs}ms | Flex Total=${flexRes.totalMs}ms (Error: ${flexRes.error || 'None'})`);
                }
            }

            const validStd = stdRuns.filter(r => !r.error);
            const validFlex = flexRuns.filter(r => !r.error);

            const stdTtft = calculateStats(validStd.map(r => r.ttftMs));
            const stdTotal = calculateStats(validStd.map(r => r.totalMs));
            const stdTokSec = calculateStats(validStd.map(r => r.tokensPerSec));

            const flexTtft = calculateStats(validFlex.map(r => r.ttftMs));
            const flexTotal = calculateStats(validFlex.map(r => r.totalMs));
            const flexTokSec = calculateStats(validFlex.map(r => r.tokensPerSec));

            const flexResourceUnavailable = flexRuns.filter(r => r.isResourceUnavailable).length;

            caseResult.models[mObj.modelId] = {
                modelLabel: mObj.label,
                provider: mObj.provider,
                standard: { tier: 'auto', ttft: stdTtft, totalLatency: stdTotal, tokensPerSec: stdTokSec, successCount: validStd.length },
                flex: { tier: 'flex', ttft: flexTtft, totalLatency: flexTotal, tokensPerSec: flexTokSec, successCount: validFlex.length, busyCount: flexResourceUnavailable }
            };

            if (!JSON_ONLY) {
                console.log(`   🔸 ${mObj.label}:`);
                console.log(`      ⚡ Standard (auto) | TTFT p50: ${stdTtft.p50}ms | Total p50: ${stdTotal.p50}ms | Speed: ${stdTokSec.p50} tok/s | Success: ${validStd.length}/${ITERATIONS}`);
                console.log(`      🌙 Flex (flex)    | TTFT p50: ${flexTtft.p50}ms | Total p50: ${flexTotal.p50}ms | Speed: ${flexTokSec.p50} tok/s | Success: ${validFlex.length}/${ITERATIONS} (Busy/429/503: ${flexResourceUnavailable})`);
            }
        }

        benchmarkResults.push(caseResult);
    }

    const finalPayload = {
        timestamp: new Date().toISOString(),
        config: {
            iterations: ITERATIONS,
            warmupRuns: WARMUP_RUNS,
            useCaseFilter: USE_CASE_FILTER,
            providerFilter: PROVIDER_FILTER,
            geminiLiteModel: GEMINI_LITE_MODEL,
            openaiModel: OPENAI_MODEL,
            timeoutMs: TIMEOUT_MS,
            fallbackOnUnavailable: FALLBACK_ON_UNAVAILABLE
        },
        results: benchmarkResults
    };

    if (OUTPUT_FILE) {
        const resolvedPath = path.resolve(process.cwd(), OUTPUT_FILE);
        await fs.writeFile(resolvedPath, JSON.stringify(finalPayload, null, 2), 'utf-8');
        if (!JSON_ONLY) console.log(`\n💾 Saved detailed multi-model Flex Processing benchmark report to: ${resolvedPath}`);
    }

    if (JSON_ONLY) {
        console.log(JSON.stringify(finalPayload, null, 2));
    } else {
        console.log(`\n══════════════════════════════════════════════════════════════════════════`);
        console.log(`📊 MULTI-MODEL FLEX PROCESSING BENCHMARK SUMMARY`);
        console.log(`══════════════════════════════════════════════════════════════════════════`);
        for (const res of benchmarkResults) {
            console.log(`📌 Case: [${res.category.toUpperCase()}] ${res.name}`);
            for (const mData of Object.values(res.models)) {
                console.log(`   • ${mData.modelLabel.padEnd(45)} Standard p50: ${String(mData.standard.totalLatency.p50).padStart(5)}ms | Flex p50: ${String(mData.flex.totalLatency.p50).padStart(5)}ms`);
            }
        }
        console.log(`══════════════════════════════════════════════════════════════════════════\n`);
    }
}

runBenchmark().catch(err => {
    console.error('❌ Benchmark error:', err);
    process.exit(1);
});
