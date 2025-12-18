import { Type } from "@google/genai";
import logger from '../../../lib/logger.js';
import { getGeminiClient } from './core.js';
import { extractTextFromResponse } from './utils.js';

// Lightweight keyword-based fallback when function-calling is skipped
function inferSearchNeedByHeuristic(userQuery) {
    if (!userQuery || typeof userQuery !== 'string') return { searchNeeded: false, reasoning: 'Invalid query' };
    const q = userQuery.toLowerCase();
    const searchKeywords = [
        'news', 'latest', 'update', 'updates', 'today', 'tonight', 'this week', 'this weekend', 'new', 'breaking',
        'release date', 'released', 'announced', 'announcement', 'earnings', 'score', 'final score', 'who won', 'winner',
        'price today', 'stock today', 'crypto', 'patch notes', 'season', 'episode', 'live', 'trending',
        'current', 'current information', 'up to date', 'current status'
    ];
    if (searchKeywords.some(k => q.includes(k))) {
        return { searchNeeded: true, reasoning: 'Query contains real-time/news-related keywords.' };
    }
    // If the query contains a very recent year, lean toward search
    const yearMatch = q.match(/\b(2024|2025|2026)\b/);
    if (yearMatch) {
        return { searchNeeded: true, reasoning: 'Query references a recent year; likely needs up-to-date info.' };
    }
    // Proper noun + news pattern (simple heuristic)
    if (/\b[a-z]+\s+news\b/i.test(userQuery)) {
        return { searchNeeded: true, reasoning: 'Entity + "news" suggests current events.' };
    }
    return { searchNeeded: false, reasoning: 'No signals indicating need for web search.' };
}

// NEW: Structured-output decision as an additional robust path
export async function decideSearchWithStructuredOutput(contextPrompt, userQuery) {
    if (!userQuery?.trim()) return { searchNeeded: false, reasoning: 'Empty query' };
    const model = getGeminiClient();

    const schema = {
        type: Type.OBJECT,
        properties: {
            searchNeeded: { type: Type.BOOLEAN },
            reasoning: { type: Type.STRING }
        },
        required: ['searchNeeded', 'reasoning'],
        propertyOrdering: ['searchNeeded', 'reasoning']
    };

    const prompt = `${contextPrompt}

User request: "${userQuery}"

Task: Decide if a web search is REQUIRED to answer accurately and up-to-date.
Return STRICT JSON ONLY matching the schema: { searchNeeded: boolean, reasoning: string }.

Guidelines:
- Mark searchNeeded = true for: news, trending topics, "what's going on with X", "who is [person]", weather in a location, live scores, stock/crypto price, release dates, patch notes, schedules, current events, specific people (streamers, celebrities, public figures), specific songs/albums/media content (titles, artists, meanings, which album/EP), or anything time-sensitive or niche.
- Mark searchNeeded = false for: abstract concepts, broad philosophical questions, creative prompts, basic math, time/date queries (handled separately).

Examples (just for guidance, do not repeat):
- "who is parfaitfair" -> {"searchNeeded": true, "reasoning": "Query about a specific person requires search to provide accurate information."}
- "who is pedromarvarez" -> {"searchNeeded": true, "reasoning": "Identifying a specific person requires current information."}
- "is sympathy is a knife about taylor swift" -> {"searchNeeded": true, "reasoning": "Query about a specific song's meaning and context requires accurate information."}
- "weather in CDMX" -> {"searchNeeded": true, "reasoning": "Weather is time-sensitive and location-specific."}
- "lil nas x news" -> {"searchNeeded": true, "reasoning": "News requires up-to-date information."}
- "what's going on with south park" -> {"searchNeeded": true, "reasoning": "TV updates are current events and change over time."}
- "who won euro 2024" -> {"searchNeeded": true, "reasoning": "Recent sports result requires verification."}
- "how do black holes form" -> {"searchNeeded": false, "reasoning": "General scientific knowledge."}
- "write a haiku about rain" -> {"searchNeeded": false, "reasoning": "Creative writing."}

Output JSON only.`;

    try {
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: 'You emit only strict JSON per the provided schema.' }] },
            generationConfig: {
                temperature: 0,
                maxOutputTokens: 80,
                responseMimeType: 'text/json', // Using text/json as schema enforcement is strict enough; application/json sometimes stricter
                responseSchema: schema
            }
        });
        const response = result;
        const candidate = response?.candidates?.[0];
        const jsonText = extractTextFromResponse(response, candidate, 'structured-decision');
        if (!jsonText) return { searchNeeded: false, reasoning: 'Empty structured response' };
        let parsed = null;
        try { parsed = JSON.parse(jsonText); } catch (_) {
            // Try a simple fix for truncated JSON (missing closing brace)
            try { parsed = JSON.parse(jsonText.trim().endsWith('}') ? jsonText : (jsonText + '}')); } catch (__) { parsed = null; }
        }
        if (parsed && typeof parsed.searchNeeded === 'boolean') {
            logger.info({ decisionPath: 'structured', parsed }, 'Structured decision produced result.');
            return { searchNeeded: parsed.searchNeeded, reasoning: parsed.reasoning || 'No reasoning provided.' };
        }
        // If JSON parsing failed or missing boolean, attempt to read an explicit boolean token
        const boolMatch = /\b(true|false)\b/i.exec(jsonText);
        if (boolMatch) {
            const boolVal = boolMatch[1].toLowerCase() === 'true';
            logger.info({ decisionPath: 'structured-parsed-bool', boolVal, raw: jsonText }, 'Parsed boolean from structured text.');
            // Extract a short reasoning string if present
            const reasonMatch = /"reasoning"\s*:\s*"([^"]+)/i.exec(jsonText);
            const reasoning = reasonMatch ? reasonMatch[1] : 'Parsed boolean from text.';
            return { searchNeeded: boolVal, reasoning };
        }
        // As a last resort, infer from the reasoning text emitted by the model
        const lower = jsonText.toLowerCase();
        const realtimeSignals = ['weather', 'news', "what's going on", 'going on with', 'today', 'this week', 'release', 'patch notes', 'live score', 'stock', 'crypto'];
        const inferred = realtimeSignals.some(k => lower.includes(k));
        if (inferred) {
            logger.info({ decisionPath: 'structured-inferred', raw: jsonText }, 'Inferred searchNeeded=true from model reasoning text.');
            return { searchNeeded: true, reasoning: 'Inferred from reasoning: time-sensitive topic.' };
        }
        logger.warn({ jsonText }, 'Structured decision parsing failed; falling back to heuristic.');
        return inferSearchNeedByHeuristic(userQuery);
    } catch (err) {
        logger.error({ err }, 'Error during structured decision call');
        return inferSearchNeedByHeuristic(userQuery);
    }
}
