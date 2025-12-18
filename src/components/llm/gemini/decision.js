import { Type } from "@google/genai";
import logger from '../../../lib/logger.js';
import { getGeminiClient } from './core.js';

// Lightweight keyword-based fallback when strict LLM call fails
function inferSearchNeedByHeuristic(userQuery) {
    if (!userQuery || typeof userQuery !== 'string') return { searchNeeded: false, reasoning: 'Invalid query' };
    const q = userQuery.toLowerCase();
    const searchKeywords = [
        'news', 'latest', 'update', 'updates', 'today', 'tonight', 'this week', 'this weekend', 'new', 'breaking',
        'release date', 'released', 'announced', 'announcement', 'earnings', 'score', 'final score', 'who won', 'winner',
        'price today', 'stock today', 'crypto', 'patch notes', 'season', 'episode', 'live', 'trending',
        'current', 'current information', 'up to date', 'current status',
        'weather', 'forecast', 'temperature', 'now', 'right now', 'how about', 'what about'
    ];
    if (searchKeywords.some(k => q.includes(k))) {
        return { searchNeeded: true, reasoning: 'Query contains real-time/news-related keywords.' };
    }
    const yearMatch = q.match(/\b(2024|2025|2026)\b/);
    if (yearMatch) {
        return { searchNeeded: true, reasoning: 'Query references a recent year; likely needs up-to-date info.' };
    }
    if (/\b[a-z]+\s+news\b/i.test(userQuery)) {
        return { searchNeeded: true, reasoning: 'Entity + "news" suggests current events.' };
    }
    return { searchNeeded: false, reasoning: 'No signals indicating need for web search.' };
}

// Structured-output decision logic
export async function decideSearchWithStructuredOutput(contextPrompt, userQuery) {
    if (!userQuery?.trim()) return { searchNeeded: false, reasoning: 'Empty query' };
    const model = getGeminiClient();

    const SearchDecisionSchema = {
        type: Type.OBJECT,
        properties: {
            searchNeeded: { type: Type.BOOLEAN },
            reasoning: { type: Type.STRING }
        },
        required: ['searchNeeded', 'reasoning']
    };

    const prompt = `${contextPrompt}

User request: "${userQuery}"

Task: Decide if a web search is REQUIRED to answer accurately and up-to-date.
Return STRICT JSON ONLY.

Guidelines:
- Mark searchNeeded = true for: news, weather, live scores, stock prices, release dates, current events, specific people/streamers/songs where info might change.
- Mark searchNeeded = false for: general knowledge, history, definitions, creative writing, jokes, math.

Output JSON only.`;

    try {
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0,
                responseMimeType: 'application/json',
                responseSchema: SearchDecisionSchema
            }
        });

        const responseText = result.candidates?.[0]?.content?.parts?.[0]?.text;
        if (responseText) {
            try {
                const parsed = JSON.parse(responseText);
                return { searchNeeded: parsed.searchNeeded, reasoning: parsed.reasoning || 'No reasoning provided.' };
            } catch (e) {
                logger.warn({ err: e, text: responseText }, 'Failed to parse structured decision response.');
            }
        }

        logger.warn('Structured decision response empty or invalid; falling back to heuristic.');
        return inferSearchNeedByHeuristic(userQuery);

    } catch (err) {
        logger.error({ err }, 'Error during structured decision call');
        return inferSearchNeedByHeuristic(userQuery);
    }
}
