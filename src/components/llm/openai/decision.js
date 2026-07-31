import logger from '../../../lib/logger.js';
import { getOpenAiInstance, getConfiguredModelId } from './core.js';
import { safeParseJsonResponse } from './utils.js';
import { SearchDecisionSchema, toOpenAiStrictSchema } from '../schemaUtils.js';
import { retryWithBackoff } from '../retryUtils.js';
import { inferSearchNeedByHeuristic } from '../searchHeuristic.js';

const strictSearchDecisionSchema = toOpenAiStrictSchema(SearchDecisionSchema);

export async function decideSearchWithStructuredOutput(contextPrompt, userQuery) {
    if (!userQuery?.trim()) return { searchNeeded: false, reasoning: 'Empty query' };
    const openai = getOpenAiInstance();
    const model = getConfiguredModelId();

    const prompt = `${contextPrompt}

User request: "${userQuery}"

Task: Decide if a web search is REQUIRED to answer accurately and up-to-date.
Return STRICT JSON ONLY.

Guidelines:
- Mark searchNeeded = true for: news, weather, live scores, stock prices, release dates, current events, specific people/streamers/songs where info might change.
- Mark searchNeeded = false for: general knowledge, history, definitions, creative writing, jokes, math.

Output JSON only.`;

    try {
        const response = await retryWithBackoff(async () => {
            return await openai.responses.create({
                model,
                input: prompt,
                text: {
                    format: {
                        type: 'json_schema',
                        name: 'search_decision',
                        strict: true,
                        schema: strictSearchDecisionSchema
                    }
                },
                reasoning: { effort: 'low' }
            });
        }, 'decideSearchWithStructuredOutput');

        const parsed = safeParseJsonResponse(response, '[Decision - SearchNeeded]');
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
