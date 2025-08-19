// Quick CLI tool to verify Gemini structured output with responseSchema
// Usage: node scripts/verify-llm-schema.js "<question>" "<answer>" "<guess>"

import { GoogleGenAI, Type } from "@google/genai";

async function main() {
  const [,, question, answer, guess] = process.argv;
  if (!question || !answer || !guess) {
    console.error("Usage: node scripts/verify-llm-schema.js \"<question>\" \"<answer>\" \"<guess>\"");
    process.exit(1);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const modelId = process.env.GEMINI_MODEL_ID || "gemini-2.5-flash";
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not set in environment.");
    process.exit(2);
  }

  const ai = new GoogleGenAI({ apiKey });

  const prompt = `Question: "${question}"
Answer: "${answer}"
Guess: "${guess}"

Return JSON ONLY: {"is_correct": boolean, "confidence": number, "reasoning": string}. Keep reasoning under 8 words.`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      is_correct: { type: Type.BOOLEAN },
      confidence: { type: Type.NUMBER },
      reasoning: { type: Type.STRING }
    },
    required: ["is_correct", "confidence", "reasoning"],
  };

  const tryOnce = async () => {
    const result = await ai.models.generateContent({
      model: modelId,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        temperature: 0.0,
        maxOutputTokens: 200,
        responseMimeType: "application/json",
        responseSchema,
        systemInstruction: {
          parts: [{ text: "You are a verifier. Output ONLY JSON that matches the schema; no chain-of-thought, no explanations." }]
        }
      }
    });
    return result;
  };

  let resp;
  try {
    resp = await tryOnce();
  } catch (e) {
    const msg = String(e?.message || "");
    if (/\b(500|internal error)\b/i.test(msg)) {
      await new Promise(r => setTimeout(r, 250));
      resp = await tryOnce();
    } else {
      throw e;
    }
  }

  const rawFromText = resp?.text;
  const rawFromCandidates = Array.isArray(resp?.candidates)
    ? (resp.candidates[0]?.content?.parts?.map(p => p?.text || '').join('').trim() || '')
    : '';
  console.log('HAS text prop:', typeof rawFromText);
  console.log('CANDIDATES len:', Array.isArray(resp?.candidates) ? resp.candidates.length : 0);
  const raw = (rawFromText && rawFromText.trim().length > 0) ? rawFromText : rawFromCandidates;
  console.log("RAW:\n" + (raw || '[empty]'));
  console.log("\nDEBUG FULL RESPONSE:\n" + JSON.stringify(resp, null, 2));
  if (resp?.parsed) {
    console.log("\nPARSED (sdk):", resp.parsed);
    process.exit(0);
  }
  try {
    const parsed = JSON.parse(raw);
    console.log("\nPARSED:", parsed);
  } catch (e) {
    console.error("\nFailed to parse JSON:", e?.message);
  }
}

main().catch(err => {
  console.error("Fatal:", err?.message || err);
  process.exit(3);
});


