// scripts/verify-summarizer.js
// End-to-end check of the map/reduce summarization flow using Gemini

import dotenv from 'dotenv';
import logger from '../src/lib/logger.js';
import { initializeGeminiClient, summarizeText } from '../src/components/llm/geminiClient.js';
import { triggerSummarizationIfNeeded } from '../src/components/context/summarizer.js';

dotenv.config();

function buildSyntheticTranscript(totalMessages = 120) {
    const users = ['alice', 'bob', 'charlie', 'dora', 'eve', 'frank'];
    const topics = [
        'game strategy',
        'funny moments',
        'stream quality',
        'new patch notes',
        'boss fight tips',
        'hardware setup',
        'controller vs keyboard',
        'chat memes',
        'backseat warnings',
        'shoutouts and raids'
    ];
    const transcript = [];
    for (let i = 0; i < totalMessages; i++) {
        const user = users[i % users.length];
        const topic = topics[i % topics.length];
        const msg = `${topic} discussion #${i + 1}: ${
            i % 7 === 0
                ? 'detailed thoughts about mechanics and timing, keeping it concise.'
                : i % 5 === 0
                ? 'short note about settings and preferences.'
                : i % 3 === 0
                ? 'quick reaction to a clutch play!'
                : 'general chatter with some context about what just happened.'
        }`;
        transcript.push({
            timestamp: new Date(),
            username: user,
            message: msg,
            tags: {}
        });
    }
    return transcript;
}

async function main() {
    try {
        const apiKey = process.env.GEMINI_API_KEY;
        const modelId = process.env.GEMINI_MODEL_ID || 'gemini-2.5-flash-lite';
        if (!apiKey) {
            logger.fatal('GEMINI_API_KEY is missing in environment. Add it to your .env and retry.');
            process.exit(1);
        }

        initializeGeminiClient({ apiKey, modelId });

        const channel = 'verify-channel';
        const transcript = buildSyntheticTranscript(120);
        logger.info(`[${channel}] Starting end-to-end summarization for ${transcript.length} messages...`);

        const start = Date.now();
        const summary = await triggerSummarizationIfNeeded(channel, transcript);
        const ms = Date.now() - start;

        if (summary) {
            logger.info({ durationMs: ms, length: summary.length }, 'Summarization completed. Preview below.');
            // Show a short preview without newlines for readability
            const preview = summary.replace(/\s+/g, ' ').slice(0, 300);
            logger.info(`SUMMARY: ${preview}${summary.length > 300 ? '…' : ''}`);
        } else {
            logger.warn({ durationMs: ms }, 'Summarization returned null/empty.');
        }

        // Scenario 2: Long command reply summarization (e.g., !ask, !game)
        const veryLongReply = Array.from({ length: 40 })
            .map((_, i) => `Paragraph ${i + 1}: This is a detailed response section with multiple clauses, examples, and clarifications tailored to the user's query, including edge cases and notes about limitations.`)
            .join(' ');
        logger.info(`Testing long command reply summarization (length=${veryLongReply.length})...`);

        const start2 = Date.now();
        const summarizedReply = await summarizeText(veryLongReply, 400);
        const ms2 = Date.now() - start2;
        if (summarizedReply) {
            logger.info({ durationMs: ms2, length: summarizedReply.length }, 'Command reply summarization completed. Preview below.');
            const preview2 = summarizedReply.replace(/\s+/g, ' ').slice(0, 300);
            logger.info(`SUMMARIZED_REPLY: ${preview2}${summarizedReply.length > 300 ? '…' : ''}`);
            process.exit(0);
        } else {
            logger.warn({ durationMs: ms2 }, 'Command reply summarization returned null/empty.');
            process.exit(2);
        }
    } catch (err) {
        logger.error({ err }, 'Verification script encountered an error.');
        process.exit(1);
    }
}

await main();


