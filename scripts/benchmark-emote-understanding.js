#!/usr/bin/env node
/**
 * scripts/benchmark-emote-understanding.js
 *
 * Benchmark suite for Twitch & 7TV Emote (Image & Animation) Understanding.
 * Evaluates vision models:
 *   - Gemini Flash Lite (gemini-flash-lite-latest) [Production Speed Tier]
 *   - Gemini 3 Flash (gemini-3-flash-preview) [Google Multimodal]
 *   - GPT 5.6 Luna (gpt-5.6-luna) [OpenAI Multimodal]
 *
 * Measures:
 *   - Asset Fetch & Frame Extraction Latency (ms)
 *   - Vision Model Inference Latency: TTFT & End-to-End Latency (ms)
 *   - Total End-to-End Pipeline Latency (ms)
 *   - Generated Visual & Emotional Descriptions for Static & Animated Emotes
 *
 * Usage:
 *   node scripts/benchmark-emote-understanding.js [options]
 *
 * Options:
 *   --iterations <N>    Number of benchmark iterations per model (default: 2)
 *   --output <path>     JSON output file path (default: scripts/benchmark-emote-results.json)
 *   --verbose           Print detailed run logs
 */

import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import sharp from 'sharp';
import fetch from 'node-fetch';
import { performance } from 'perf_hooks';
import fs from 'fs/promises';
import path from 'path';

// ── Environment & Clients Setup ───────────────────────────────────────────────
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

// ── Command Line Options ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag, defaultValue) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
    return defaultValue;
}
const ITERATIONS = parseInt(getArg('--iterations', '2'), 10);
const OUTPUT_FILE = getArg('--output', 'scripts/benchmark-emote-results.json');
const VERBOSE = args.includes('--verbose');

// ── Emote Test Dataset ────────────────────────────────────────────────────────
const EMOTE_DATASET = [
    // ── Static Emotes ──
    {
        id: 'twitch_kappa',
        name: 'Kappa',
        type: 'static',
        provider: 'Twitch',
        url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/static/dark/3.0',
        expectedSentiment: 'Sarcasm, irony, smirking joke'
    },
    {
        id: 'twitch_lul',
        name: 'LUL',
        type: 'static',
        provider: 'Twitch',
        url: 'https://static-cdn.jtvnw.net/emoticons/v2/425618/static/dark/3.0',
        expectedSentiment: 'Hysterical laughter, comedy'
    },
    {
        id: 'twitch_wutface',
        name: 'WutFace',
        type: 'static',
        provider: 'Twitch',
        url: 'https://static-cdn.jtvnw.net/emoticons/v2/28087/static/dark/3.0',
        expectedSentiment: 'Shock, disgust, disbelief'
    },
    {
        id: 'twitch_notlikethis',
        name: 'NotLikeThis',
        type: 'static',
        provider: 'Twitch',
        url: 'https://static-cdn.jtvnw.net/emoticons/v2/58765/static/dark/3.0',
        expectedSentiment: 'Frustration, facepalm, despair'
    },
    {
        id: 'twitch_vohiyo',
        name: 'VoHiYo',
        type: 'static',
        provider: 'Twitch',
        url: 'https://static-cdn.jtvnw.net/emoticons/v2/81274/static/dark/3.0',
        expectedSentiment: 'Warm greeting, anime wave'
    },

    // ── Animated Emotes ──
    {
        id: '7tv_petpet',
        name: 'PETPET',
        type: 'animated',
        provider: '7TV',
        url: 'https://cdn.7tv.app/emote/01FE3XY508000AA32JP519W2EW/2x.webp',
        expectedSentiment: 'Rapid petting on head, affection'
    },
    {
        id: '7tv_partyparrot',
        name: 'PartyParrot',
        type: 'animated',
        provider: '7TV',
        url: 'https://cdn.7tv.app/emote/01FKSDK14G0008TM5NY9QEG0QV/2x.webp',
        expectedSentiment: 'Colorful rotating dancing parrot, hype party'
    },
    {
        id: '7tv_clap',
        name: 'Clap',
        type: 'animated',
        provider: '7TV',
        url: 'https://cdn.7tv.app/emote/01GAM8EFQ00004MXFXAJYKA859/2x.webp',
        expectedSentiment: 'Applause, clapping hands'
    },
    {
        id: '7tv_pepepls',
        name: 'PepePls',
        type: 'animated',
        provider: '7TV',
        url: 'https://cdn.7tv.app/emote/01GAFTZ9K80003DHH026MC7JW0/2x.webp',
        expectedSentiment: 'Pepe dancing side to side, grooving'
    },
    {
        id: '7tv_raintime',
        name: 'RainTime',
        type: 'animated',
        provider: '7TV',
        url: 'https://cdn.7tv.app/emote/01FCY771D800007PQ2DF3GDTN6/2x.webp',
        expectedSentiment: 'Sad frog sitting in falling rain, gloom'
    }
];

// SYSTEM PROMPTS
const SYSTEM_INSTRUCTION = `You are a visual assistant that describes Twitch chat emotes so a chat AI can understand them.
Rules:
- Reply with ONLY a concise visual description (2-8 words). No preamble, no quotes.
- Do not output the raw emote name string verbatim.
- Prioritize emotional sentiment and action depicted.`;

// ── Asset Loading & Processing ───────────────────────────────────────────────
async function loadEmoteAsset(item) {
    const startFetch = performance.now();
    const res = await fetch(item.url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${item.url}`);
    const rawBuffer = Buffer.from(await res.arrayBuffer());
    const fetchMs = performance.now() - startFetch;

    const startExtract = performance.now();
    let imageBuffer;
    let mimeType = 'image/png';
    let frameCount = 1;

    if (item.type === 'animated') {
        const pipeline = sharp(rawBuffer, { animated: true });
        const metadata = await pipeline.metadata();
        frameCount = metadata.pages || 1;
        imageBuffer = await pipeline.png().toBuffer();
    } else {
        imageBuffer = await sharp(rawBuffer).png().toBuffer();
    }
    const extractMs = performance.now() - startExtract;

    return {
        buffer: imageBuffer,
        base64: imageBuffer.toString('base64'),
        mimeType,
        frameCount,
        fetchMs: Math.round(fetchMs),
        extractMs: Math.round(extractMs)
    };
}

// ── Model Vision Runners ──────────────────────────────────────────────────────

// 1. Gemini Models (Gemini Flash Lite & Gemini 3 Flash)
async function testGeminiVision(modelId, item, asset) {
    if (!aiClient) return null;

    const prompt = item.type === 'animated'
        ? `This is a vertical animation strip of the Twitch emote "${item.name}" with ${asset.frameCount} frames stacked top-to-bottom in sequence. Describe what happens across the animation in 2-8 words. Include the emotional intent or action (e.g. dancing, applause, sadness). Be concise.`
        : `Describe this Twitch emote named "${item.name}" in 2-8 words. Include the emotional sentiment or intent (e.g. sarcasm, laughter, shock). Be concise.`;

    const startInference = performance.now();
    let ttftMs = null;
    let text = '';

    try {
        const stream = await aiClient.models.generateContentStream({
            model: modelId,
            contents: [
                {
                    role: 'user',
                    parts: [
                        { inlineData: { mimeType: asset.mimeType, data: asset.base64 } },
                        { text: prompt }
                    ]
                }
            ],
            config: {
                systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
                temperature: 0.2
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
                if (ttftMs === null) ttftMs = performance.now() - startInference;
                text += chunkText;
            }
        }

        const totalInferenceMs = performance.now() - startInference;
        if (ttftMs === null) ttftMs = totalInferenceMs;

        const tokenEstimate = Math.ceil(text.length / 4);

        return {
            model: modelId,
            ttftMs: Math.round(ttftMs),
            totalMs: Math.round(totalInferenceMs),
            e2ePipelineMs: Math.round(asset.fetchMs + asset.extractMs + totalInferenceMs),
            description: text.trim().replace(/^["']|["']$/g, ''),
            tokensPerSec: totalInferenceMs > 0 ? +(tokenEstimate / (totalInferenceMs / 1000)).toFixed(1) : 0
        };
    } catch (err) {
        return { model: modelId, error: err.message };
    }
}

// 2. OpenAI GPT 5.6 Luna Vision
async function testOpenAiVision(item, asset) {
    if (!openaiClient) return null;

    const prompt = item.type === 'animated'
        ? `This is a vertical animation strip of the Twitch emote "${item.name}" with ${asset.frameCount} frames stacked top-to-bottom in sequence. Describe what happens across the animation in 2-8 words. Include the emotional intent or action (e.g. dancing, applause, sadness). Be concise.`
        : `Describe this Twitch emote named "${item.name}" in 2-8 words. Include the emotional sentiment or intent (e.g. sarcasm, laughter, shock). Be concise.`;

    const startInference = performance.now();
    let ttftMs = null;
    let text = '';

    try {
        const stream = await openaiClient.chat.completions.create({
            model: process.env.OPENAI_MODEL_ID || 'gpt-5.6-luna',
            messages: [
                { role: 'system', content: SYSTEM_INSTRUCTION },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        {
                            type: 'image_url',
                            image_url: { url: `data:${asset.mimeType};base64,${asset.base64}` }
                        }
                    ]
                }
            ],
            stream: true
        });

        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content || '';
            if (delta.length > 0) {
                if (ttftMs === null) ttftMs = performance.now() - startInference;
                text += delta;
            }
        }

        const totalInferenceMs = performance.now() - startInference;
        if (ttftMs === null) ttftMs = totalInferenceMs;

        const tokenEstimate = Math.ceil(text.length / 4);

        return {
            model: process.env.OPENAI_MODEL_ID || 'gpt-5.6-luna',
            ttftMs: Math.round(ttftMs),
            totalMs: Math.round(totalInferenceMs),
            e2ePipelineMs: Math.round(asset.fetchMs + asset.extractMs + totalInferenceMs),
            description: text.trim().replace(/^["']|["']$/g, ''),
            tokensPerSec: totalInferenceMs > 0 ? +(tokenEstimate / (totalInferenceMs / 1000)).toFixed(1) : 0
        };
    } catch (err) {
        return { model: process.env.OPENAI_MODEL_ID || 'gpt-5.6-luna', error: err.message };
    }
}

// ── Statistical Helper ────────────────────────────────────────────────────────
function median(arr) {
    if (!arr || arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 !== 0 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// ── Main Execution ────────────────────────────────────────────────────────────
async function main() {
    console.log(`\n================================================================================`);
    console.log(`🖼️  TWITCH & 7TV EMOTE UNDERSTANDING BENCHMARK SUITE`);
    console.log(`================================================================================`);
    console.log(`Models Evaluated:`);
    console.log(`  1. ⚡ Gemini Flash Lite   (gemini-flash-lite-latest) [Production Speed Tier]`);
    console.log(`  2. ✨ Gemini 3 Flash     (gemini-3-flash-preview)`);
    console.log(`  3. 🌙 GPT 5.6 Luna       (${process.env.OPENAI_MODEL_ID || 'gpt-5.6-luna'})`);
    console.log(`Iterations per item: ${ITERATIONS}`);
    console.log(`Dataset size: ${EMOTE_DATASET.length} emotes (5 Static, 5 Animated)\n`);

    const results = [];

    for (const item of EMOTE_DATASET) {
        console.log(`--------------------------------------------------------------------------------`);
        console.log(`📦 [${item.type.toUpperCase()}] ${item.name} (${item.provider}) — Expected: "${item.expectedSentiment}"`);

        // Load asset
        let asset;
        try {
            asset = await loadEmoteAsset(item);
            console.log(`   Asset Loaded: Fetch=${asset.fetchMs}ms | Extract=${asset.extractMs}ms | Frames=${asset.frameCount} frame(s)`);
        } catch (e) {
            console.error(`   ❌ Failed to load asset for ${item.name}:`, e.message);
            continue;
        }

        const itemRes = {
            id: item.id,
            name: item.name,
            type: item.type,
            provider: item.provider,
            expectedSentiment: item.expectedSentiment,
            assetMetrics: {
                fetchMs: asset.fetchMs,
                extractMs: asset.extractMs,
                frameCount: asset.frameCount
            },
            models: {}
        };

        // Models to benchmark
        const modelsToTest = [];
        if (aiClient) {
            modelsToTest.push({ key: 'geminiLite', id: 'gemini-flash-lite-latest', runner: (it, a) => testGeminiVision('gemini-flash-lite-latest', it, a) });
            modelsToTest.push({ key: 'gemini3', id: 'gemini-3-flash-preview', runner: (it, a) => testGeminiVision('gemini-3-flash-preview', it, a) });
        }
        if (openaiClient) {
            modelsToTest.push({ key: 'openaiLuna', id: process.env.OPENAI_MODEL_ID || 'gpt-5.6-luna', runner: (it, a) => testOpenAiVision(it, a) });
        }

        for (const m of modelsToTest) {
            const runs = [];
            for (let i = 0; i < ITERATIONS; i++) {
                const res = await m.runner(item, asset);
                if (res && !res.error) {
                    runs.push(res);
                } else if (res?.error) {
                    if (VERBOSE) console.error(`      ❌ ${m.id} run error: ${res.error}`);
                }
            }

            if (runs.length > 0) {
                const ttft = median(runs.map(r => r.ttftMs));
                const total = median(runs.map(r => r.totalMs));
                const pipeline = median(runs.map(r => r.e2ePipelineMs));
                const description = runs[0].description;

                itemRes.models[m.key] = {
                    modelId: m.id,
                    ttftMs: ttft,
                    inferenceTotalMs: total,
                    e2ePipelineMs: pipeline,
                    description
                };

                console.log(`   • ${m.id.padEnd(26)} => TTFT: ${ttft}ms | Inference: ${total}ms | E2E Pipeline: ${pipeline}ms`);
                console.log(`     💬 Description: "${description}"`);
            }
        }

        results.push(itemRes);
    }

    // ── Global Aggregates ─────────────────────────────────────────────────────
    const summary = {
        static: {},
        animated: {},
        overall: {}
    };

    const modelKeys = ['geminiLite', 'gemini3', 'openaiLuna'];

    for (const mKey of modelKeys) {
        const staticTtft = results.filter(r => r.type === 'static' && r.models[mKey]).map(r => r.models[mKey].ttftMs);
        const staticTotal = results.filter(r => r.type === 'static' && r.models[mKey]).map(r => r.models[mKey].inferenceTotalMs);
        const staticPipeline = results.filter(r => r.type === 'static' && r.models[mKey]).map(r => r.models[mKey].e2ePipelineMs);

        const animTtft = results.filter(r => r.type === 'animated' && r.models[mKey]).map(r => r.models[mKey].ttftMs);
        const animTotal = results.filter(r => r.type === 'animated' && r.models[mKey]).map(r => r.models[mKey].inferenceTotalMs);
        const animPipeline = results.filter(r => r.type === 'animated' && r.models[mKey]).map(r => r.models[mKey].e2ePipelineMs);

        const allTtft = [...staticTtft, ...animTtft];
        const allTotal = [...staticTotal, ...animTotal];
        const allPipeline = [...staticPipeline, ...animPipeline];

        if (allTtft.length > 0) {
            summary.overall[mKey] = {
                ttftP50: median(allTtft),
                inferenceP50: median(allTotal),
                pipelineP50: median(allPipeline)
            };
            summary.static[mKey] = {
                ttftP50: median(staticTtft),
                inferenceP50: median(staticTotal),
                pipelineP50: median(staticPipeline)
            };
            summary.animated[mKey] = {
                ttftP50: median(animTtft),
                inferenceP50: median(animTotal),
                pipelineP50: median(animPipeline)
            };
        }
    }

    console.log(`\n================================================================================`);
    console.log(`📊 EMOTE UNDERSTANDING BENCHMARK SUMMARY (Median p50 Latencies)`);
    console.log(`================================================================================`);
    console.log(`STATIC EMOTES (5 Twitch Emotes):`);
    for (const mKey of modelKeys) {
        if (summary.static[mKey]) {
            const s = summary.static[mKey];
            console.log(`  • ${mKey.padEnd(12)}: TTFT=${s.ttftP50}ms | Inference=${s.inferenceP50}ms | E2E Pipeline=${s.pipelineP50}ms`);
        }
    }

    console.log(`\nANIMATED EMOTES (5 7TV Animation Strips):`);
    for (const mKey of modelKeys) {
        if (summary.animated[mKey]) {
            const s = summary.animated[mKey];
            console.log(`  • ${mKey.padEnd(12)}: TTFT=${s.ttftP50}ms | Inference=${s.inferenceP50}ms | E2E Pipeline=${s.pipelineP50}ms`);
        }
    }

    console.log(`\nOVERALL ALL EMOTES (10 Emotes Combined):`);
    for (const mKey of modelKeys) {
        if (summary.overall[mKey]) {
            const s = summary.overall[mKey];
            console.log(`  • ${mKey.padEnd(12)}: TTFT=${s.ttftP50}ms | Inference=${s.inferenceP50}ms | E2E Pipeline=${s.pipelineP50}ms`);
        }
    }
    console.log(`================================================================================\n`);

    // Output JSON File
    const finalReport = {
        timestamp: new Date().toISOString(),
        datasetSize: results.length,
        iterations: ITERATIONS,
        summary,
        results
    };

    const resolvedOutput = path.resolve(process.cwd(), OUTPUT_FILE);
    await fs.writeFile(resolvedOutput, JSON.stringify(finalReport, null, 2), 'utf-8');
    console.log(`💾 Saved benchmark report to: ${resolvedOutput}\n`);
}

main().catch(err => {
    console.error('❌ Emote benchmark failed:', err);
    process.exit(1);
});
