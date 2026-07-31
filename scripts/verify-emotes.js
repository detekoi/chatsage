#!/usr/bin/env node
// scripts/verify-emotes.js
// Emote/vision verification through the REAL production modules
// (geminiEmoteDescriber + llmClient.describeImages) on the active provider.
//   LLM_PROVIDER=openai node scripts/verify-emotes.js
// Flags: --animated-id <twitch emote id>  (a channel/global emote that has an
//        animated variant on the Twitch CDN; without it the animated-strip path
//        is exercised with a locally synthesized frame strip instead)

import dotenv from 'dotenv';
// .env overrides stale system vars, but an explicitly shell-passed LLM_PROVIDER
// (e.g. `LLM_PROVIDER=gemini node scripts/...`) must win over .env.
const shellProvider = process.env.LLM_PROVIDER;
dotenv.config({ override: true });
if (shellProvider) process.env.LLM_PROVIDER = shellProvider;
import sharp from 'sharp';

const argv = process.argv.slice(2);
const idFlag = argv.indexOf('--animated-id');
const animatedId = idFlag !== -1 ? argv[idFlag + 1] : null;

const { default: config } = await import('../src/config/loader.js');
const { initializeLlmClient, describeImages } = await import('../src/components/llm/llmClient.js');
const { describeSingleEmote, fetchAnimatedEmoteFrames } = await import('../src/lib/geminiEmoteDescriber.js');

console.log(`[Verification] Provider: ${config.llm?.provider || 'gemini'}`);
initializeLlmClient(config);

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
}

// ── 1. Static emote through the real describer (Kappa, global emote id 25) ──
console.log('\n--- 1. Static Emote Description (Kappa) ---');
{
    const start = Date.now();
    const description = await describeSingleEmote('25', 'Kappa', false);
    check('Static emote described', !!description, `"${description}" (${Date.now() - start}ms)`);
}

// ── 2. Animated emote from the Twitch CDN (optional, needs a real animated id) ──
console.log('\n--- 2. Animated Emote via CDN ---');
if (animatedId) {
    const frames = await fetchAnimatedEmoteFrames(animatedId);
    if (frames) {
        console.log(`  Frame strip: ${frames.data.length} bytes (${frames.mimeType})`);
        const start = Date.now();
        const description = await describeSingleEmote(animatedId, 'testAnimated', true);
        check('Animated CDN emote described', !!description, `"${description}" (${Date.now() - start}ms)`);
    } else {
        check('Animated CDN fetch', false, `no animated variant found for id "${animatedId}"`);
    }
} else {
    console.log('  ⏭️  Skipped (pass --animated-id <id> of an emote with an animated variant)');
}

// ── 3. Animated-strip vision path with a synthesized strip ──
// Guarantees the vertical-frame-strip prompt/vision path is exercised even
// without a CDN animated emote: 4 frames, red→yellow→green→blue.
console.log('\n--- 3. Synthesized Animation Strip ---');
{
    const colors = [
        { r: 220, g: 40, b: 40 }, { r: 230, g: 200, b: 40 },
        { r: 40, g: 180, b: 60 }, { r: 40, g: 90, b: 220 },
    ];
    const frames = await Promise.all(colors.map(background =>
        sharp({ create: { width: 112, height: 112, channels: 3, background } }).png().toBuffer()
    ));
    const strip = await sharp({ create: { width: 112, height: 112 * 4, channels: 3, background: { r: 0, g: 0, b: 0 } } })
        .composite(frames.map((input, i) => ({ input, top: i * 112, left: 0 })))
        .png()
        .toBuffer();

    const start = Date.now();
    const description = await describeImages({
        parts: [{ inlineData: { mimeType: 'image/png', data: strip.toString('base64') } }],
        prompt: 'This is a vertical animation strip — all frames stacked top-to-bottom in sequence. Describe what happens across the animation in 2-8 words.',
    });
    const mentionsColor = /red|yellow|green|blue|colou?r/i.test(description || '');
    check('Synth strip described', !!description, `"${description}" (${Date.now() - start}ms)`);
    check('Description reflects frame content', mentionsColor);
}

// ── 4. Stream-thumbnail style image through describeImages ──
console.log('\n--- 4. Thumbnail-style Vision ---');
{
    const thumb = await sharp({
        create: { width: 1280, height: 720, channels: 3, background: { r: 25, g: 30, b: 60 } }
    })
        .composite([{
            input: await sharp({ create: { width: 400, height: 200, channels: 3, background: { r: 200, g: 60, b: 60 } } }).png().toBuffer(),
            top: 260, left: 440,
        }])
        .jpeg()
        .toBuffer();

    const start = Date.now();
    const description = await describeImages({
        parts: [{ inlineData: { mimeType: 'image/jpeg', data: thumb.toString('base64') } }],
        prompt: 'Briefly describe this image in one sentence.',
    });
    check('Thumbnail described', !!description, `"${description}" (${Date.now() - start}ms)`);
}

console.log(`\n${failures === 0 ? '✅ All emote/vision verifications passed' : `❌ ${failures} verification(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
