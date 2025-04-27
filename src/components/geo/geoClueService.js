import { getGeminiClient } from '../llm/geminiClient.js';
import logger from '../../lib/logger.js';

/**
 * Generates the initial clue for a location at the specified difficulty.
 * @param {string} locationName
 * @param {string} difficulty - 'easy' | 'normal' | 'hard'
 * @returns {Promise<string|null>}
 */
export async function generateInitialClue(locationName, difficulty = 'normal') {
    const prompt = `You are the Geo-Game Clue Generator. Generate the FIRST clue for the location "${locationName}" for a geography guessing game.
- Difficulty: ${difficulty}
- The clue should be accurate, not too obvious, and not too obscure for the chosen difficulty.
- Do NOT reveal the location name or any direct synonyms.
- Respond with a single clue sentence.`;
    const model = getGeminiClient();
    logger.debug({ locationName, difficulty, prompt }, '[GeoClue] Generating initial clue');
    try {
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: 'Respond ONLY with the clue sentence. Do not use markdown or formatting.' }] }
        });
        const response = result.response;
        if (!response.candidates?.length || !response.candidates[0].content) {
            logger.warn('[GeoClue] No candidates/content in initial clue response');
            return null;
        }
        const text = response.candidates[0].content.parts.map(part => part.text).join('').trim();
        return text || null;
    } catch (error) {
        logger.error({ err: error }, '[GeoClue] Error generating initial clue');
        return null;
    }
}

/**
 * Generates a follow-up clue for a location, given previous clues.
 * @param {string} locationName
 * @param {string[]} previousClues
 * @returns {Promise<string|null>}
 */
export async function generateFollowUpClue(locationName, previousClues = []) {
    const prompt = `You are the Geo-Game Clue Generator. Generate a NEW clue for the location "${locationName}" for a geography guessing game.
- Previous clues: ${previousClues.length ? previousClues.map((c, i) => `(${i+1}) ${c}`).join(' | ') : 'None'}
- The new clue must NOT repeat or closely paraphrase any previous clues.
- Make the clue slightly more specific or revealing than the last one, but do NOT give away the answer.
- Respond with a single clue sentence.`;
    const model = getGeminiClient();
    logger.debug({ locationName, previousClues, prompt }, '[GeoClue] Generating follow-up clue');
    try {
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: 'Respond ONLY with the clue sentence. Do not use markdown or formatting.' }] }
        });
        const response = result.response;
        if (!response.candidates?.length || !response.candidates[0].content) {
            logger.warn('[GeoClue] No candidates/content in follow-up clue response');
            return null;
        }
        const text = response.candidates[0].content.parts.map(part => part.text).join('').trim();
        return text || null;
    } catch (error) {
        logger.error({ err: error }, '[GeoClue] Error generating follow-up clue');
        return null;
    }
}

/**
 * Generates a fun, informative summary or reveal for the location.
 * @param {string} locationName
 * @returns {Promise<string|null>}
 */
export async function generateFinalReveal(locationName) {
    const prompt = `You are the Geo-Game Reveal Generator. Write a fun, informative summary or reveal for the location "${locationName}" for a geography guessing game.
- Include a few interesting facts or context about the location.
- Make it engaging and suitable for a Twitch chat audience.
- Respond with a short paragraph (2-4 sentences).`;
    const model = getGeminiClient();
    logger.debug({ locationName, prompt }, '[GeoClue] Generating final reveal');
    try {
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: 'Respond ONLY with the reveal paragraph. Do not use markdown or formatting.' }] }
        });
        const response = result.response;
        if (!response.candidates?.length || !response.candidates[0].content) {
            logger.warn('[GeoClue] No candidates/content in final reveal response');
            return null;
        }
        const text = response.candidates[0].content.parts.map(part => part.text).join('').trim();
        return text || null;
    } catch (error) {
        logger.error({ err: error }, '[GeoClue] Error generating final reveal');
        return null;
    }
}
