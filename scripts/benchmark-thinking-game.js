// scripts/benchmark-thinking-game.js
import 'dotenv/config';
import OpenAI from 'openai';
import { performance } from 'perf_hooks';

const apiKey = process.env.OPENAI_API_KEY;
const modelId = process.env.OPENAI_MODEL_ID || 'gpt-5.6-luna';

if (!apiKey) {
    console.error('❌ OPENAI_API_KEY is required in environment.');
    process.exit(1);
}

const openai = new OpenAI({ apiKey });

const testCases = [
    {
        id: 'waterpark_simulator_remove_item',
        game: 'Waterpark Simulator',
        question: 'how do you remove an item',
        expectedAnswer: 'Press B, select Demolish (wrecking-ball icon), then click the item. Or equip sledgehammer and hold left-click.',
        keyFacts: ['demolish', 'b', 'sledgehammer', 'wrecking']
    },
    {
        id: 'schedule_1_clean_money',
        game: 'Schedule 1',
        question: 'how do you wash dirty cash into clean money',
        expectedAnswer: 'Buy front businesses (Laundromat, Taco Shop, Car Wash) and assign staff/deposit dirty money to launder it.',
        keyFacts: ['front', 'laundromat', 'taco', 'car wash', 'launder', 'business']
    },
    {
        id: 'palworld_repair',
        game: 'Palworld',
        question: 'how do you repair damaged weapons and armor',
        expectedAnswer: 'Build and use a Repair Bench, selecting the damaged item and using the required repair materials.',
        keyFacts: ['repair bench', 'materials']
    },
    {
        id: 'lethal_company_radar',
        game: 'Lethal Company',
        question: 'how do you use the radar booster',
        expectedAnswer: 'Place it on ground, activate via switch. Ship terminal can "ping [name]" to make sound or "flash [name]" to blind enemies.',
        keyFacts: ['ping', 'flash', 'terminal', 'ship']
    },
    {
        id: 'helldivers_2_stratagem_jammer',
        game: 'Helldivers 2',
        question: 'how do you destroy stratagem jammers',
        expectedAnswer: 'Disable terminal at base & call Hellbomb, or destroy connected Automaton fabricator.',
        keyFacts: ['hellbomb', 'terminal', 'fabricator']
    },
    {
        id: 'rust_repair_wall',
        game: 'Rust',
        question: 'how do you repair a damaged base wall',
        expectedAnswer: 'Equip Hammer, look at wall, hold Right-Click and select Repair (costs materials from inventory).',
        keyFacts: ['hammer', 'right-click', 'repair', 'materials']
    }
];

const effortLevels = ['low', 'medium', 'high'];

async function runBenchmark() {
    console.log(`\n🎮 Benchmarking GPT-5.6 Luna Thinking Levels for !game queries`);
    console.log(`Model: ${modelId}`);
    console.log(`Effort levels: ${effortLevels.join(', ')}\n`);

    for (const testCase of testCases) {
        console.log(`==================================================`);
        console.log(`🎯 Test Case: ${testCase.game} - "${testCase.question}"`);
        console.log(`Expected Key Details: ${testCase.expectedAnswer}`);
        console.log(`==================================================\n`);

        const helpSearchQuery = `Use web search to answer: "${testCase.question}" for "${testCase.game}". Give a direct, factual tip in ≤ 320 chars. Plain text. No citations, no markdown.`;

        for (const effort of effortLevels) {
            process.stdout.write(`  ⏳ Running thinking level [${effort.toUpperCase()}]... `);
            const start = performance.now();

            try {
                const response = await openai.responses.create({
                    model: modelId,
                    input: helpSearchQuery,
                    instructions: `You are ChatSage, an AI chatbot for Twitch streams. You MUST use web search to retrieve accurate real-world info. Answer directly in plain text, ≤ 320 chars.`,
                    tools: [{ type: 'web_search' }],
                    reasoning: { effort }
                });

                const latencyMs = Math.round(performance.now() - start);

                // Extract text response
                let text = response.output_text?.trim() || '';
                if (!text && Array.isArray(response.output)) {
                    for (const item of response.output) {
                        if (item.type === 'message' && Array.isArray(item.content)) {
                            for (const c of item.content) {
                                if (c.type === 'text' && c.text) text += c.text;
                                else if (c.text?.value) text += c.text.value;
                            }
                        }
                    }
                }
                text = text.trim();

                // Check search calls count
                const searchCalls = response.output?.filter(item => item.type === 'web_search_call') || [];

                // Key facts match check
                const lowerText = text.toLowerCase();
                const matchedFacts = testCase.keyFacts.filter(fact => lowerText.includes(fact.toLowerCase()));
                const matchScore = `${matchedFacts.length}/${testCase.keyFacts.length}`;

                console.log(`Done (${latencyMs}ms, ${searchCalls.length} search calls, Key fact match: ${matchScore})`);
                console.log(`     Response: "${text}"\n`);
            } catch (err) {
                console.log(`❌ ERROR: ${err.message}\n`);
            }
        }
    }
}

runBenchmark().catch(console.error);
