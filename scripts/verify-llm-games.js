#!/usr/bin/env node
// scripts/verify-llm-games.js
// End-to-end game/structured-output regression gate through the REAL production
// modules. Runs on whichever provider LLM_PROVIDER selects:
//   LLM_PROVIDER=openai node scripts/verify-llm-games.js
//   LLM_PROVIDER=gemini node scripts/verify-llm-games.js   (no-regression baseline)
// Flags: --runs N (default 3 generation attempts per game for stats)

import dotenv from 'dotenv';
// .env overrides stale system vars, but an explicitly shell-passed LLM_PROVIDER
// (e.g. `LLM_PROVIDER=gemini node scripts/...`) must win over .env.
const shellProvider = process.env.LLM_PROVIDER;
dotenv.config({ override: true });
if (shellProvider) process.env.LLM_PROVIDER = shellProvider;

const argv = process.argv.slice(2);
const runsFlag = argv.indexOf('--runs');
const RUNS = runsFlag !== -1 ? parseInt(argv[runsFlag + 1], 10) : 3;

const { default: config } = await import('../src/config/loader.js');
const { initializeLlmClient, decideSearchWithStructuredOutput, fetchIanaTimezoneForLocation } = await import('../src/components/llm/llmClient.js');
const { generateQuestion, verifyAnswer, generateExplanation } = await import('../src/components/trivia/triviaQuestionService.js');
const { generateRiddle, verifyRiddleAnswer } = await import('../src/components/riddle/riddleService.js');
const { generateInitialClue, generateFollowUpClue } = await import('../src/components/geo/geoClueService.js');
const { selectLocation, validateGuess } = await import('../src/components/geo/geoLocationService.js');

console.log(`[Verification] Provider: ${config.llm?.provider || 'gemini'} | Runs per game: ${RUNS}`);
initializeLlmClient(config);

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
}

async function timed(fn) {
    const start = Date.now();
    const value = await fn();
    return { value, ms: Date.now() - start };
}

// ── 1. Trivia: N generation runs (counts leak-guard rejections separately) ──
console.log('\n--- 1. Trivia Question Service ---');
{
    let valid = 0, totalMs = 0;
    for (let i = 0; i < RUNS; i++) {
        const { value: q, ms } = await timed(() => generateQuestion('gaming', 'normal'));
        totalMs += ms;
        if (q?.question && q?.answer) {
            valid++;
            console.log(`  run ${i + 1} (${ms}ms): "${q.question}" → "${q.answer}" (search=${q.searchUsed})`);
        } else {
            console.log(`  run ${i + 1} (${ms}ms): null (leak-guard rejection or generation failure — see logs above)`);
        }
    }
    check(`Trivia generation`, valid >= Math.ceil(RUNS / 2), `${valid}/${RUNS} valid, avg ${Math.round(totalMs / RUNS)}ms`);

    const { value: localized } = await timed(() => generateQuestion('general', 'normal', [], null, [], 'spanish'));
    check('Trivia localized (spanish)', !!(localized?.question && localized?.answerEnglish), localized ? `"${localized.question}" (EN: ${localized.answerEnglish})` : 'null');

    const exact = await verifyAnswer('Game controller', 'game controller');
    check('Trivia verify exact-match fast path', exact.is_correct === true);
    const { value: fuzzy, ms: verifyMs } = await timed(() => verifyAnswer('The Legend of Zelda', 'zelda ocarina', [], 'Which series features Link?', 'gaming'));
    check('Trivia verify LLM path returns shape', typeof fuzzy?.is_correct === 'boolean', `is_correct=${fuzzy?.is_correct}, ${verifyMs}ms`);

    const explanation = await generateExplanation('Which console launched with Wii Sports?', 'The Wii', 'gaming');
    check('Trivia explanation', !!explanation && !explanation.startsWith('The correct answer is'), `"${explanation}"`);
}

// ── 2. Riddle ──
console.log('\n--- 2. Riddle Service ---');
{
    let valid = 0;
    let lastRiddle = null;
    for (let i = 0; i < RUNS; i++) {
        const { value: r, ms } = await timed(() => generateRiddle('gaming', 'normal', [], null));
        if (r?.question && r?.answer) {
            valid++;
            lastRiddle = r;
            console.log(`  run ${i + 1} (${ms}ms): "${r.question}" → "${r.answer}"`);
        } else {
            console.log(`  run ${i + 1} (${ms}ms): null`);
        }
    }
    check('Riddle generation', valid >= Math.ceil(RUNS / 2), `${valid}/${RUNS} valid`);

    if (lastRiddle) {
        const v = await verifyRiddleAnswer(lastRiddle.answer, lastRiddle.answer, lastRiddle.question, 'gaming');
        check('Riddle verify (exact answer accepted)', v?.isCorrect === true, JSON.stringify(v));
    }
}

// ── 3. Geo: selection, clues, validation ──
console.log('\n--- 3. Geo Services ---');
{
    const { value: loc, ms } = await timed(() => selectLocation('real', {}, null, ['Tokyo', 'Paris']));
    check('Geo selectLocation', !!loc?.name, loc ? `"${loc.name}" (${ms}ms, alts: ${loc.alternateNames?.join('/') || 'none'})` : 'null');

    const { value: clue } = await timed(() => generateInitialClue('Tokyo', 'normal', 'real'));
    const clueText = typeof clue === 'string' ? clue : clue?.clue_text;
    check('Geo initial clue', !!clueText, `"${(clueText || '').slice(0, 80)}..."`);

    const { value: followUp } = await timed(() => generateFollowUpClue('Tokyo', [clueText || 'A big city'], 'real', null, 2));
    const followText = typeof followUp === 'string' ? followUp : followUp?.clue_text;
    check('Geo follow-up clue', !!followText);

    const correct = await validateGuess('Tokyo', 'Tokyo');
    check('Geo validate correct guess', correct?.is_correct === true, `confidence=${correct?.confidence}`);
    const wrong = await validateGuess('Tokyo', 'Osaka');
    check('Geo validate wrong guess', wrong?.is_correct === false, `reasoning="${wrong?.reasoning}"`);
}

// ── 4. Decision + timezone (shared structured-output plumbing) ──
console.log('\n--- 4. Search Decision & Timezone ---');
{
    const needs = await decideSearchWithStructuredOutput('', 'what is the weather in tokyo right now');
    check('Decision: weather → search needed', needs?.searchNeeded === true, needs?.reasoning);
    const noNeed = await decideSearchWithStructuredOutput('', 'tell me a joke about cats');
    check('Decision: joke → no search', noNeed?.searchNeeded === false, noNeed?.reasoning);

    const tz = await fetchIanaTimezoneForLocation('San Diego');
    check('Timezone lookup', tz === 'America/Los_Angeles', `got "${tz}"`);
}

console.log(`\n${failures === 0 ? '✅ All game verifications passed' : `❌ ${failures} verification(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
