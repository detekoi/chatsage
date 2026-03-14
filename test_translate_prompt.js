import { GoogleGenAI } from "@google/genai";
import { Type } from "@google/genai";
import dotenv from "dotenv";
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const testCases = [
    // False positives we fixed
    { text: "Denn, do you play Pokopia?", target: "English", expect: "SAME" },
    { text: "Ditto_Kak", target: "English", expect: "SAME" },
    // Genuine foreign — must translate
    { text: "todo bien joto", target: "English", expect: "TRANSLATE" },
    { text: "Hola, ¿cómo estás?", target: "English", expect: "TRANSLATE" },
    { text: "Bonjour tout le monde", target: "English", expect: "TRANSLATE" },
    // Obvious English — must not translate
    { text: "hello everyone!", target: "English", expect: "SAME" },
];

const schema = {
    type: Type.OBJECT,
    properties: {
        same_language: { type: Type.BOOLEAN },
        translated_text: { type: Type.STRING }
    },
    required: ['same_language', 'translated_text']
};

async function testPrompt(label, buildPrompt) {
    console.log(`\n${'='.repeat(60)}\nPROMPT: ${label}\n${'='.repeat(60)}`);
    let pass = 0, fail = 0;
    for (const tc of testCases) {
        const result = await ai.models.generateContent({
            model: 'gemini-3.1-flash-lite-preview',
            contents: [{ role: 'user', parts: [{ text: buildPrompt(tc.text, tc.target) }] }],
            config: { maxOutputTokens: 512, temperature: 0.3, responseMimeType: 'application/json', responseSchema: schema }
        });
        const parsed = JSON.parse(result.candidates[0].content.parts[0].text);
        const actual = parsed.same_language ? 'SAME' : `TRANSLATE → "${parsed.translated_text}"`;
        const ok = (tc.expect === 'SAME') === parsed.same_language;
        console.log(`  ${ok ? '✅' : '❌'} [expect:${tc.expect}] "${tc.text}" → ${actual}`);
        ok ? pass++ : fail++;
    }
    console.log(`  → ${pass}/${pass+fail} passed`);
}

// CURRENT (subtle, may over-suppress)
const current = (text, target) => `You are a professional interpreter for Twitch live-stream chat. Analyze the following text and translate it into ${target}.
Rules:
1. If the text is already in ${target}, set same_language to true and leave translated_text empty.
2. Otherwise, set same_language to false and provide the translation in translated_text.
3. Preserve the original formatting — no markdown, no quotes, no explanations.
4. Chat messages often contain nicknames, game terms, and slang that may resemble foreign words — these are not indicators of a different language. When in doubt, prefer same_language = true.

Text:
${text}`;

// REFINED: keep Twitch context, but anchor doubt-rule only to non-Latin/ambiguous tokens
const refined = (text, target) => `You are a professional interpreter for Twitch live-stream chat. Analyze the following text and translate it into ${target}.
Rules:
1. If the text is already in ${target}, set same_language to true and leave translated_text empty.
2. Otherwise, set same_language to false and provide the translation in translated_text.
3. Preserve the original formatting — no markdown, no quotes, no explanations.
4. Strings that look like usernames, game titles, or internet slang (e.g. single tokens, CamelCase, underscores, or made-up words) are not foreign language — do not treat them as such.
5. Clear sentences or phrases in a real human language that is not ${target} must be translated.

Text:
${text}`;

async function main() {
    await testPrompt("CURRENT (subtle)", current);
    await testPrompt("REFINED (username heuristic + clear sentences rule)", refined);
}
main().catch(console.error);
