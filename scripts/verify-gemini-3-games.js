// scripts/verify-gemini-3-games.js
import dotenv from 'dotenv';
dotenv.config();

import logger from '../src/lib/logger.js';
import { generateQuestion, verifyAnswer } from '../src/components/trivia/triviaQuestionService.js';
import { generateRiddle, verifyRiddleAnswer } from '../src/components/riddle/riddleService.js';
import { generateInitialClue, generateFollowUpClue, generateFinalReveal } from '../src/components/geo/geoClueService.js';
import { decideSearchWithStructuredOutput } from '../src/components/llm/gemini/decision.js';
import { fetchIanaTimezoneForLocation, summarizeText } from '../src/components/llm/gemini/generation.js';
import { initializeGeminiClient } from '../src/components/llm/gemini/core.js';

async function runVerification() {
    logger.info("=== STARTING GEMINI 3 VERIFICATION ===");

    try {
        initializeGeminiClient({
            apiKey: process.env.GEMINI_API_KEY,
            modelId: process.env.GEMINI_MODEL_ID || 'gemini-2.5-flash'
        });
    } catch (e) {
        logger.error({ err: e }, "Failed to initialize Gemini Client");
        process.exit(1);
    }

    let failures = 0;

    // --- TRIVIA ---
    logger.info("\n--- TRIVIA TEST ---");
    try {
        const tQ = await generateQuestion("general knowledge", "normal");
        if (tQ && tQ.question && tQ.answer && tQ.verified === true) {
            logger.info({ tQ }, "Trivia Gen (General): SUCCESS");
        } else {
            logger.error({ tQ }, "Trivia Gen (General): FAILED");
            failures++;
        }

        const tQSearch = await generateQuestion("Elden Ring", "hard"); // Specific topic forces search
        if (tQSearch && tQSearch.question && tQSearch.searchUsed === true) {
            logger.info({ tQSearch }, "Trivia Gen (Search/Game): SUCCESS");
        } else {
            logger.error({ tQSearch }, "Trivia Gen (Search/Game): FAILED");
            failures++;
        }

        // Verification
        const tVerify = await verifyAnswer("Paris", "paris", [], "Capital of France?", "geography");
        if (tVerify && tVerify.is_correct === true) {
            logger.info({ tVerify }, "Trivia Verify (Correct): SUCCESS");
        } else {
            logger.error({ tVerify }, "Trivia Verify (Correct): FAILED");
            failures++;
        }
    } catch (e) {
        logger.error({ err: e }, "Trivia Test EXCEPTION");
        failures++;
    }

    // --- RIDDLE ---
    logger.info("\n--- RIDDLE TEST ---");
    try {
        const rQ = await generateRiddle("mirror", "easy");
        if (rQ && rQ.question && rQ.answer) {
            logger.info({ rQ }, "Riddle Gen: SUCCESS");
        } else {
            logger.error({ rQ }, "Riddle Gen: FAILED");
            failures++;
        }

        const rVerify = await verifyRiddleAnswer("mirror", "a mirror", rQ?.question || "I verify faces but have none", "mirror");
        if (rVerify && rVerify.isCorrect === true) {
            logger.info({ rVerify }, "Riddle Verify (Correct): SUCCESS");
        } else {
            logger.error({ rVerify }, "Riddle Verify (Correct): FAILED");
            failures++;
        }
    } catch (e) {
        logger.error({ err: e }, "Riddle Test EXCEPTION");
        failures++;
    }

    // --- GEO ---
    logger.info("\n--- GEO TEST ---");
    try {
        const clue1 = await generateInitialClue("Tokyo", "normal");
        if (typeof clue1 === 'string' && clue1.length > 10) {
            logger.info({ clue1 }, "Geo Initial Clue: SUCCESS");
        } else {
            logger.error({ clue1 }, "Geo Initial Clue: FAILED");
            failures++;
        }

        const clue2 = await generateFollowUpClue("Tokyo", [clue1], "real");
        if (typeof clue2 === 'string' && clue2.length > 10) {
            logger.info({ clue2 }, "Geo FollowUp Clue: SUCCESS");
        } else {
            logger.error({ clue2 }, "Geo FollowUp Clue: FAILED");
            failures++;
        }

        const reveal = await generateFinalReveal("Tokyo", "real", null, "guessed");
        if (typeof reveal === 'string' && reveal.length > 10) {
            logger.info({ reveal }, "Geo Reveal: SUCCESS");
        } else {
            logger.error({ reveal }, "Geo Reveal: FAILED");
            failures++;
        }
    } catch (e) {
        logger.error({ err: e }, "Geo Test EXCEPTION");
        failures++;
    }

    // --- UTILS ---
    logger.info("\n--- UTILS TEST ---");
    try {
        const decision = await decideSearchWithStructuredOutput("Current context.", "Who won the super bowl 2024?");
        if (decision && typeof decision.searchNeeded === 'boolean') {
            logger.info({ decision }, "Decision (Search): SUCCESS");
        } else {
            logger.error({ decision }, "Decision (Search): FAILED");
            failures++;
        }

        const tz = await fetchIanaTimezoneForLocation("London");
        if (tz === "Europe/London") {
            logger.info({ tz }, "Timezone Parsing: SUCCESS");
        } else {
            logger.error({ tz }, "Timezone Parsing: FAILED");
            failures++;
        }

        const summary = await summarizeText("This is a very long text that needs to be summarized. It has many words and sentences. Parsing this correctly ensures structured output works.", 50);
        if (typeof summary === 'string') {
            logger.info({ summary }, "Summary: SUCCESS");
        } else {
            logger.error({ summary }, "Summary: FAILED");
            failures++;
        }
    } catch (e) {
        logger.error({ err: e }, "Utils Test EXCEPTION");
        failures++;
    }


    if (failures === 0) {
        logger.info("\n=== VERIFICATION COMPLETE: ALL TESTS PASSED ===");
        process.exit(0);
    } else {
        logger.error(`\n=== VERIFICATION COMPLETE: ${failures} FAILURES ===`);
        process.exit(1);
    }
}

runVerification();
