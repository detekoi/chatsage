#!/usr/bin/env node
// scripts/verify-llm-prompts.js
// Custom command / timer / check-in prompt verification through the REAL
// promptResolver module (the lite-model + web-search path used by the web UI's
// "AI Mode" commands). Dedup (channel/source) is deliberately omitted so the
// script runs without Firestore.
//   LLM_PROVIDER=openai node scripts/verify-llm-prompts.js

import dotenv from 'dotenv';
// .env overrides stale system vars, but an explicitly shell-passed LLM_PROVIDER
// (e.g. `LLM_PROVIDER=gemini node scripts/...`) must win over .env.
const shellProvider = process.env.LLM_PROVIDER;
dotenv.config({ override: true });
if (shellProvider) process.env.LLM_PROVIDER = shellProvider;

const { default: config } = await import('../src/config/loader.js');
const { initializeLlmClient } = await import('../src/components/llm/llmClient.js');
const { resolvePrompt } = await import('../src/components/customCommands/promptResolver.js');

console.log(`[Verification] Provider: ${config.llm?.provider || 'gemini'}`);
initializeLlmClient(config);

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
}

const STREAM_CONTEXT = 'Channel: parfaittest | Game: The Legend of Zelda: Tears of the Kingdom | Title: zelda totk first playthrough!';
const CHAT_CONTEXT = [
    'velvetmoth: this game looks so beautiful',
    'neonpuddle: ultrahand is gonna change everything',
    'glitchfox: the music up here is incredible',
].join('\n');

// ── 1. Ad-lib custom command (no search expected) ──────────────────────
console.log('\n--- 1. Custom Command (ad-lib) ---');
{
    const start = Date.now();
    const text = await resolvePrompt(
        'Hype up the viewer named $(user) who just used the !hype command. One energetic sentence.'.replace('$(user)', 'velvetmoth'),
        null,
        STREAM_CONTEXT
    );
    check('Ad-lib command response', !!text && text.length <= 450, `"${text}" (${Date.now() - start}ms)`);
}

// ── 2. Search-needing custom command ───────────────────────────────────
console.log('\n--- 2. Custom Command (web search) ---');
{
    const start = Date.now();
    const text = await resolvePrompt(
        'Look up the current weather in Tokyo and report it in one playful sentence.',
        null,
        STREAM_CONTEXT
    );
    check('Search-grounded command response', !!text && text.length <= 450, `"${text}" (${Date.now() - start}ms)`);
}

// ── 3. Timer-style prompt with chat context ────────────────────────────
console.log('\n--- 3. Timer Prompt ---');
{
    const start = Date.now();
    const text = await resolvePrompt(
        'Remind chat to stay hydrated. Riff on the current stream mood if it fits, one sentence.',
        null,
        STREAM_CONTEXT,
        false,
        { chatContext: CHAT_CONTEXT }
    );
    check('Timer response', !!text && text.length <= 450, `"${text}" (${Date.now() - start}ms)`);
}

// ── 4. Check-in prompt (isCheckin adds the count-context hint) ─────────
console.log('\n--- 4. Check-in Prompt ---');
{
    const start = Date.now();
    const text = await resolvePrompt(
        'Welcome back viewer glitchfox for check-in number 42. One warm, personal sentence.',
        null,
        STREAM_CONTEXT,
        true
    );
    const mentionsFirst = /first (viewer|to arrive|in stream)/i.test(text || '');
    check('Check-in response', !!text && text.length <= 450, `"${text}" (${Date.now() - start}ms)`);
    check('Check-in count not misread as "first in stream"', !mentionsFirst);
}

// ── 5. Localized prompt (botlang path used by timers/commands) ─────────
console.log('\n--- 5. Localized Prompt (spanish) ---');
{
    const start = Date.now();
    const text = await resolvePrompt(
        'Thank the chat for hanging out today. One sentence.',
        'spanish',
        STREAM_CONTEXT
    );
    const looksSpanish = /[áéíóñü¡¿]|gracias|hoy|chat/i.test(text || '');
    check('Localized response', !!text, `"${text}" (${Date.now() - start}ms)`);
    check('Response appears to be in Spanish', looksSpanish);
}

console.log(`\n${failures === 0 ? '✅ All prompt verifications passed' : `❌ ${failures} verification(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
