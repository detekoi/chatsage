import { getGeminiClient } from '../llm/geminiClient.js';
import logger from '../../lib/logger.js';

/**
 * Generates the initial clue for a location at the specified difficulty.
 * @param {string} locationName
 * @param {string} difficulty - 'easy' | 'normal' | 'hard'
 * @param {'real'|'game'} mode
 * @param {string|null} gameTitle
 * @returns {Promise<string|null>}
 */
export async function generateInitialClue(locationName, difficulty = 'normal', mode = 'real', gameTitle = null) {
    const prompt = `You are the Geo-Game Clue Generator. Generate the FIRST clue for the location "${locationName}" for a geography guessing game.${mode === 'game' && gameTitle ? ` The location is from the video game "${gameTitle}". Use search if available to ensure accuracy.` : ''}
- Difficulty: ${difficulty}
- The clue should be accurate, not too obvious, and not too obscure for the chosen difficulty.
- Do NOT reveal the location name or any direct synonyms.
- Respond with a single clue sentence.`;
    const model = getGeminiClient();
    logger.debug({ locationName, difficulty, mode, gameTitle, prompt }, '[GeoClue] Generating initial clue');
    try {
        const generateOptions = {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: 'Respond ONLY with the clue sentence. Do not use markdown or formatting.' }] }
        };
        if (mode === 'game') {
            logger.debug(`[GeoClue] Enabling search tool for initial clue (Mode: ${mode}, Game: ${gameTitle})`);
            generateOptions.tools = [{ googleSearch: {} }];
        }
        const result = await model.generateContent(generateOptions);
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
 * @param {'real'|'game'} mode
 * @param {string|null} gameTitle
 * @param {number} clueNumber
 * @returns {Promise<string|null>}
 */
export async function generateFollowUpClue(locationName, previousClues = [], mode = 'real', gameTitle = null, clueNumber = 2) {
    const prompt = `You are the Geo-Game Clue Generator. Generate a NEW clue for the location "${locationName}" for a geography guessing game.${mode === 'game' && gameTitle ? ` The location is from the video game "${gameTitle}". Use search if available to ensure accuracy.` : ''}
- Previous clues: ${previousClues.length ? previousClues.map((c, i) => `(${i+1}) ${c}`).join(' | ') : 'None'}
- The new clue must NOT repeat or closely paraphrase any previous clues.
- Make the clue slightly more specific or revealing than the last one, but do NOT give away the answer.
- Respond with a single clue sentence.`;
    const model = getGeminiClient();
    logger.debug({ locationName, previousClues, mode, gameTitle, clueNumber, prompt }, '[GeoClue] Generating follow-up clue');
    try {
        const generateOptions = {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: 'Respond ONLY with the clue sentence. Do not use markdown or formatting.' }] }
        };
        // Enable search for game mode OR for follow-up/reveal in real mode if desired
        if (mode === 'game' || (mode === 'real' && clueNumber > 1)) {
            logger.debug(`[GeoClue] Enabling search tool for follow-up clue (Mode: ${mode}, Game: ${gameTitle}, Clue #: ${clueNumber})`);
            generateOptions.tools = [{ googleSearch: {} }];
        }
        const result = await model.generateContent(generateOptions);
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
 * Generates a fun, informative summary or reveal for the location, tailored to the reason the game ended.
 * @param {string} locationName
 * @param {'real'|'game'} mode
 * @param {string|null} gameTitle
 * @param {string} reason - Why the game ended ("guessed", "timeout", "stopped", etc)
 * @returns {Promise<string|null>}
 */
export async function generateFinalReveal(locationName, mode = 'real', gameTitle = null, reason = "unknown") {
    let outcomeContext = "";
    if (reason === "guessed") {
        outcomeContext = "The players successfully guessed the location! Write a fun, celebratory summary for the location.";
    } else if (reason === "timeout") {
        outcomeContext = "Time ran out before anyone guessed correctly. Write a fun, informative summary for the location.";
    } else if (reason === "stopped") {
        outcomeContext = "The game was stopped manually. Write a simple, informative summary for the location.";
    } else {
        outcomeContext = "Write a fun, informative summary for the location."; // Default
    }

    const prompt = `You are the Geo-Game Reveal Generator. ${outcomeContext} The location was "${locationName}".${mode === 'game' && gameTitle ? ` The location is from the video game "${gameTitle}". Use search if available to ensure accuracy.` : ''}
- Include a few interesting facts or context about the location.
- Make it engaging and suitable for a Twitch chat audience. Avoid starting with "Congrats" or similar if the reason was 'timeout' or 'stopped'.
- Respond with a short paragraph (2-4 sentences).`;
    const model = getGeminiClient();
    logger.debug({ locationName, mode, gameTitle, reason, prompt }, '[GeoClue] Generating final reveal');
    try {
        const generateOptions = {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: 'Respond ONLY with the reveal paragraph. Do not use markdown or formatting.' }] }
        };
        if (mode === 'game') {
            logger.debug(`[GeoClue] Enabling search tool for final reveal (Mode: ${mode}, Game: ${gameTitle})`);
            generateOptions.tools = [{ googleSearch: {} }];
        }
        const result = await model.generateContent(generateOptions);
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
