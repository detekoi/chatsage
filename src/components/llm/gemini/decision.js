import logger from '../../../lib/logger.js';
import { getGeminiClient } from './core.js';
import { safeParseJsonResponse } from './utils.js';
import { SearchDecisionSchema, toGeminiSchema } from '../schemaUtils.js';

const geminiSearchDecisionSchema = toGeminiSchema(SearchDecisionSchema);

// Re-exported for backwards compatibility; the implementation is shared with
// the openai provider in ../searchHeuristic.js.
import { inferSearchNeedByHeuristic } from '../searchHeuristic.js';
export { inferSearchNeedByHeuristic };

// Structured-output decision logic
export async function decideSearchWithStructuredOutput(contextPrompt, userQuery) {
    if (!userQuery?.trim()) return { searchNeeded: false, reasoning: 'Empty query' };
    const model = getGeminiClient();

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
                responseSchema: geminiSearchDecisionSchema
            }
        });

        const parsed = safeParseJsonResponse(result, '[Decision - SearchNeeded]');
        if (parsed) {
            return { searchNeeded: parsed.searchNeeded, reasoning: parsed.reasoning || 'No reasoning provided.' };
        }

        logger.warn('Structured decision response empty or invalid; falling back to heuristic.');
        return inferSearchNeedByHeuristic(userQuery);

    } catch (err) {
        logger.error({ err }, 'Error during structured decision call');
        return inferSearchNeedByHeuristic(userQuery);
    }
}
