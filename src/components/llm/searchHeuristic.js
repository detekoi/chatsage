// Provider-agnostic keyword fallback for the "does this query need web search?"
// decision, shared by the gemini and openai decision modules.

/**
 * Lightweight keyword-based fallback when the strict LLM decision call fails.
 * @param {string} userQuery
 * @returns {{searchNeeded: boolean, reasoning: string}}
 */
export function inferSearchNeedByHeuristic(userQuery) {
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
