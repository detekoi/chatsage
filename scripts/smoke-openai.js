// scripts/smoke-openai.js
import OpenAI from 'openai';
import sharp from 'sharp';

// Parse command line flags
const args = process.argv.slice(2);
function getArgValue(flag, defaultValue) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
    return defaultValue;
}

const model = getArgValue('--model', process.env.OPENAI_MODEL_ID || 'gpt-5.6-luna');
const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
    console.error('❌ Missing OPENAI_API_KEY in environment.');
    process.exit(1);
}

console.log(`🚀 Starting Phase 0 Smoke Test for model: ${model}`);

const openai = new OpenAI({ apiKey });

async function runSmokeTests() {
    let passed = 0;
    let failed = 0;

    // Helper for test execution
    async function test(name, fn) {
        process.stdout.write(`  Testing ${name}... `);
        try {
            await fn();
            console.log('✅ PASSED');
            passed++;
        } catch (err) {
            console.log(`❌ FAILED: ${err.message}`);
            if (err.response) {
                console.error('    Response:', JSON.stringify(err.response, null, 2));
            }
            failed++;
        }
    }

    // 1. Basic Text Completion
    await test('Basic Responses API completion', async () => {
        const response = await openai.responses.create({
            model,
            input: 'Reply with the single word PONG.'
        });
        const text = response.output_text?.trim() || '';
        if (!text.toLowerCase().includes('pong')) {
            throw new Error(`Unexpected response text: "${text}"`);
        }
    });

    // 2. Strict Structured Output
    await test('Strict Structured Output (JSON Schema)', async () => {
        const response = await openai.responses.create({
            model,
            input: 'Provide details for the city Paris.',
            text: {
                format: {
                    type: 'json_schema',
                    name: 'city_info',
                    strict: true,
                    schema: {
                        type: 'object',
                        properties: {
                            city: { type: 'string' },
                            country: { type: 'string' },
                            population_approx: { type: 'number' }
                        },
                        required: ['city', 'country', 'population_approx'],
                        additionalProperties: false
                    }
                }
            }
        });

        const text = response.output_text;
        const parsed = JSON.parse(text);
        if (!parsed.city || !parsed.country) {
            throw new Error(`Parsed schema missing fields: ${text}`);
        }
    });

    // 3. Web Search + Structured Output Combined
    await test('Web Search + Structured Output combined', async () => {
        const response = await openai.responses.create({
            model,
            input: 'What is the capital of France and what is the current local date in UTC? Search if needed.',
            tools: [{ type: 'web_search' }],
            text: {
                format: {
                    type: 'json_schema',
                    name: 'search_result',
                    strict: true,
                    schema: {
                        type: 'object',
                        properties: {
                            capital: { type: 'string' },
                            search_performed: { type: 'boolean' }
                        },
                        required: ['capital', 'search_performed'],
                        additionalProperties: false
                    }
                }
            }
        });

        const text = response.output_text;
        const parsed = JSON.parse(text);
        if (!parsed.capital) {
            throw new Error(`Combined search + schema failed: ${text}`);
        }
    });

    // 4. Function Tool Calling Round-Trip
    await test('Function Tool Calling Round-Trip', async () => {
        const initial = await openai.responses.create({
            model,
            input: 'What is the current time in Tokyo?',
            tools: [{
                type: 'function',
                name: 'getCurrentTime',
                description: 'Get the current time in a given timezone',
                parameters: {
                    type: 'object',
                    properties: {
                        timezone: { type: 'string', description: 'IANA timezone' }
                    },
                    required: ['timezone'],
                    additionalProperties: false
                },
                strict: true
            }]
        });

        const toolCalls = initial.output?.filter(item => item.type === 'function_call') || [];
        if (toolCalls.length === 0) {
            throw new Error('Model did not make a function_call turn');
        }

        const call = toolCalls[0];

        // Follow-up with function result
        const followup = await openai.responses.create({
            model,
            previous_response_id: initial.id,
            input: [{
                type: 'function_call_output',
                call_id: call.call_id,
                output: JSON.stringify({ current_time: '2026-07-31 03:55:00 JST' })
            }]
        });

        const finalText = followup.output_text || '';
        if (!finalText.length) {
            throw new Error('Followup response empty');
        }
    });

    // 5. Vision / Image Input (Static PNG & Animated GIF vertical strip)
    await test('Vision Input (Static PNG & Frame Strip)', async () => {
        // Create 64x64 red PNG buffer using sharp
        const redPngBuffer = await sharp({
            create: {
                width: 64,
                height: 64,
                channels: 4,
                background: { r: 255, g: 0, b: 0, alpha: 1 }
            }
        }).png().toBuffer();

        // Create 64x128 2-frame vertical strip using sharp
        const frameStripBuffer = await sharp({
            create: {
                width: 64,
                height: 128,
                channels: 4,
                background: { r: 0, g: 0, b: 255, alpha: 1 }
            }
        }).png().toBuffer();

        const pngDataUri = `data:image/png;base64,${redPngBuffer.toString('base64')}`;
        const stripDataUri = `data:image/png;base64,${frameStripBuffer.toString('base64')}`;

        const response = await openai.responses.create({
            model,
            input: [
                {
                    role: 'user',
                    content: [
                        { type: 'input_image', image_url: pngDataUri },
                        { type: 'input_image', image_url: stripDataUri },
                        { type: 'input_text', text: 'Describe the primary color of the first image and the second image. Reply in 1 sentence.' }
                    ]
                }
            ]
        });

        const text = response.output_text || '';
        if (!text.toLowerCase().includes('red') && !text.toLowerCase().includes('blue')) {
            throw new Error(`Vision output did not describe colors: "${text}"`);
        }
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

runSmokeTests().catch(err => {
    console.error('Fatal error during smoke test:', err);
    process.exit(1);
});
