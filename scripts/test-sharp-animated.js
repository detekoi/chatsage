// scripts/test-sharp-animated.js
import fetch from 'node-fetch';
import sharp from 'sharp';

async function testAnimatedExtraction(name, url) {
    console.log(`Fetching animated emote [${name}]: ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const pipeline = sharp(buffer, { animated: true });
    const metadata = await pipeline.metadata();
    console.log(`  Format: ${metadata.format}, pages/frames: ${metadata.pages}, width: ${metadata.width}, height: ${metadata.height}`);

    const stripBuffer = await pipeline.png().toBuffer();
    console.log(`  Extracted frame strip PNG size: ${stripBuffer.length} bytes`);
    return stripBuffer;
}

async function main() {
    await testAnimatedExtraction('PETPET', 'https://cdn.7tv.app/emote/01FE3XY508000AA32JP519W2EW/2x.webp');
    await testAnimatedExtraction('PartyParrot', 'https://cdn.7tv.app/emote/01FKSDK14G0008TM5NY9QEG0QV/2x.webp');
    await testAnimatedExtraction('Clap', 'https://cdn.7tv.app/emote/01GAM8EFQ00004MXFXAJYKA859/2x.webp');
}

main().catch(err => console.error(err));
