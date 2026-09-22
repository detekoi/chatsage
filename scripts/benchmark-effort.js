#!/usr/bin/env node
/**
 * scripts/benchmark-effort.js
 *
 * Compares end-to-end latency of OpenAI reasoning effort levels on the call shapes
 * that use the default effort (config.openai.reasoningEffort):
 *   - chat:   short persona reply to a chat message (openai/chat.js)
 *   - json:   structured JSON output (llmClient generateStructured path)
 *   - search: web_search tool answer (openai/generation.js search responses)
 *
 * Effort levels are interleaved per iteration so network/API drift hits all levels equally.
 *
 * Usage:
 *   node scripts/benchmark-effort.js [--efforts low,medium] [--iterations 8] [--cases chat,json,search]
 *                                    [--model gpt-6-luna] [--output results.json] [--verbose]
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { performance } from 'perf_hooks';
import fs from 'fs/promises';

const args = process.argv.slice(2);
function getArg(flag, defaultValue) {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : defaultValue;
}

const EFFORTS = getArg('--efforts', 'low,medium').split(',').map(s => s.trim()).filter(Boolean);
const ITERATIONS = parseInt(getArg('--iterations', '8'), 10);
const CASE_FILTER = getArg('--cases', 'chat,json,search').split(',').map(s => s.trim());
const MODEL = getArg('--model', process.env.OPENAI_MODEL_ID || 'gpt-6-luna');
const OUTPUT_FILE = getArg('--output', null);
const VERBOSE = args.includes('--verbose');

if (!process.env.OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY is required in environment.');
    process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PERSONA = `You are ChatSage, a friendly, witty AI chatbot in a Twitch stream's chat. Reply in one short message suitable for Twitch chat (under 300 characters). Plain text, no markdown. Match the chat's energy.`;

const CASES = [
    {
        id: 'chat',
        label: 'Chat reply',
        prompts: [
            'viewer_42: @ChatSage what do you think of the streamer\'s build so far?',
            'pixelfox: @ChatSage give me a hype line for this boss fight',
            'mossy_dev: @ChatSage why is the sky blue, explain like I\'m 5',
            'kappa_king: @ChatSage roast my username gently',
        ],
        build: prompt => ({ instructions: PERSONA, input: prompt }),
    },
    {
        id: 'json',
        label: 'Structured JSON',
        prompts: [
            'Is this chat message a question the bot should answer? Message: "anyone know when the next patch drops?"',
            'Is this chat message a question the bot should answer? Message: "lol that was insane"',
            'Is this chat message a question the bot should answer? Message: "@ChatSage what rank is the streamer"',
        ],
        build: prompt => ({
            instructions: 'Classify the chat message. Respond only with the requested JSON.',
            input: prompt,
            text: {
                format: {
                    type: 'json_schema',
                    name: 'classification',
                    strict: true,
                    schema: {
                        type: 'object',
                        properties: {
                            shouldAnswer: { type: 'boolean' },
                            reason: { type: 'string' },
                        },
                        required: ['shouldAnswer', 'reason'],
                        additionalProperties: false,
                    },
                },
            },
        }),
    },
    {
        id: 'search',
        label: 'Web search',
        prompts: [
            'Use web search to answer: "how do you repair weapons" for "Palworld". Direct tip in ≤ 320 chars, plain text, no citations.',
            'Use web search to answer: "how do you destroy stratagem jammers" for "Helldivers 2". Direct tip in ≤ 320 chars, plain text, no citations.',
            'Use web search to answer: "how do you launder money" for "Schedule 1". Direct tip in ≤ 320 chars, plain text, no citations.',
        ],
        build: prompt => ({ instructions: PERSONA, input: prompt, tools: [{ type: 'web_search' }] }),
    },
].filter(c => CASE_FILTER.includes(c.id));

async function runOnce(testCase, prompt, effort) {
    const start = performance.now();
    try {
        const response = await openai.responses.create({
            model: MODEL,
            reasoning: { effort },
            ...testCase.build(prompt),
        });
        const latencyMs = performance.now() - start;
        const usage = response.usage || {};
        return {
            ok: true,
            latencyMs,
            outputTokens: usage.output_tokens ?? null,
            reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? null,
            text: (response.output_text || '').trim(),
        };
    } catch (err) {
        return { ok: false, latencyMs: performance.now() - start, error: `${err.status ?? ''} ${err.message}`.trim() };
    }
}

function percentile(sorted, p) {
    if (!sorted.length) return NaN;
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, idx)];
}

function summarize(runs) {
    const ok = runs.filter(r => r.ok);
    const lat = ok.map(r => r.latencyMs).sort((a, b) => a - b);
    const avg = arr => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : NaN);
    return {
        n: ok.length,
        errors: runs.length - ok.length,
        p50: percentile(lat, 50),
        p90: percentile(lat, 90),
        mean: avg(lat),
        max: lat[lat.length - 1] ?? NaN,
        reasoningTokens: avg(ok.map(r => r.reasoningTokens).filter(v => v != null)),
        outputTokens: avg(ok.map(r => r.outputTokens).filter(v => v != null)),
    };
}

const fmt = v => (Number.isFinite(v) ? Math.round(v).toString() : '-');

async function main() {
    console.log(`\nModel: ${MODEL} | efforts: ${EFFORTS.join(', ')} | iterations: ${ITERATIONS} | cases: ${CASES.map(c => c.id).join(', ')}\n`);

    const results = {};
    for (const testCase of CASES) {
        results[testCase.id] = Object.fromEntries(EFFORTS.map(e => [e, []]));

        // One unmeasured warmup per effort to absorb connection setup.
        for (const effort of EFFORTS) await runOnce(testCase, testCase.prompts[0], effort);

        for (let i = 0; i < ITERATIONS; i++) {
            const prompt = testCase.prompts[i % testCase.prompts.length];
            // Alternate which effort goes first each iteration.
            const order = i % 2 === 0 ? EFFORTS : [...EFFORTS].reverse();
            for (const effort of order) {
                const run = await runOnce(testCase, prompt, effort);
                results[testCase.id][effort].push(run);
                process.stdout.write(run.ok ? '.' : 'x');
                if (VERBOSE) console.log(`\n  [${testCase.id}/${effort}] ${Math.round(run.latencyMs)}ms ${run.ok ? run.text : run.error}`);
            }
        }
        process.stdout.write(` ${testCase.label}\n`);
    }

    console.log('\nLatency in ms (end-to-end, non-streaming). Tokens are per-request means.\n');
    console.log('case     effort   n  err   p50    p90   mean    max  reason_tok  out_tok');
    const summary = {};
    for (const testCase of CASES) {
        summary[testCase.id] = {};
        for (const effort of EFFORTS) {
            const s = summarize(results[testCase.id][effort]);
            summary[testCase.id][effort] = s;
            console.log(
                `${testCase.id.padEnd(8)} ${effort.padEnd(7)} ${String(s.n).padStart(2)} ${String(s.errors).padStart(4)} ` +
                `${fmt(s.p50).padStart(5)} ${fmt(s.p90).padStart(6)} ${fmt(s.mean).padStart(6)} ${fmt(s.max).padStart(6)} ` +
                `${fmt(s.reasoningTokens).padStart(11)} ${fmt(s.outputTokens).padStart(8)}`
            );
        }
    }

    const errors = CASES.flatMap(c => EFFORTS.flatMap(e => results[c.id][e].filter(r => !r.ok).map(r => `${c.id}/${e}: ${r.error}`)));
    if (errors.length) console.log(`\nErrors:\n  ${[...new Set(errors)].join('\n  ')}`);

    if (OUTPUT_FILE) {
        await fs.writeFile(OUTPUT_FILE, JSON.stringify({ model: MODEL, efforts: EFFORTS, iterations: ITERATIONS, summary, results }, null, 2));
        console.log(`\nSaved detailed results to ${OUTPUT_FILE}`);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
