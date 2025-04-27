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
    const prompt = `You are the Geo-Game Clue Generator, creating evocative descriptions. Generate the FIRST clue for the location "${locationName}" for a geography guessing game.${mode === 'game' && gameTitle ? ` The location is from the video game "${gameTitle}". Use search if available to ensure accuracy.` : ''}
- Difficulty: ${difficulty}
- Focus on sensory details (sight, sound, smell, feeling) or the general atmosphere/impression of the place.
- Hint subtly at the geographic region (continent, climate) or general context (real-world vs. game setting type) without being overly specific.
- Sprinkle in a small factual detail if it fits naturally with the description.
- Do NOT reveal the location name or any direct synonyms.
- Respond with a single, engaging clue sentence (around 200-350 characters).`;
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
 * @param {string[]} [incorrectGuessReasons=[]] - Optional array of reasons for recent incorrect guesses.
 * @returns {Promise<string|null>}
 */
export async function generateFollowUpClue(locationName, previousClues = [], mode = 'real', gameTitle = null, clueNumber = 2, incorrectGuessReasons = []) {
    let reasonGuidance = '';
    if (incorrectGuessReasons && incorrectGuessReasons.length > 0) {
        // Simple summary of reasons
        const uniqueReasons = [...new Set(incorrectGuessReasons)].filter(r => r.trim() !== '');
        if (uniqueReasons.length > 0) {
             reasonGuidance = `
- Recent incorrect guesses suggest confusion about: ${uniqueReasons.join('; ')}. Use this insight subtly to guide players towards the correct location without being obvious.`;
        }
    }

    const prompt = `You are the Geo-Game Clue Generator, creating evocative descriptions. Generate a NEW clue for the location "${locationName}" for a geography guessing game.${mode === 'game' && gameTitle ? ` The location is from the video game "${gameTitle}". Use search if available to ensure accuracy.` : ''}
- Previous clues: ${previousClues.length ? previousClues.map((c, i) => `(${i+1}) ${c}`).join(' | ') : 'None'}${reasonGuidance}
- The new clue must NOT repeat or closely paraphrase information from previous clues.
- Make the clue slightly more specific, focusing on a distinct sensory detail, a historical echo, a cultural element, or a unique environmental feature.
- Weave in a helpful factual hint if possible, but prioritize the evocative description.
- Do NOT give away the answer directly.
- Respond with a single, engaging clue sentence (around 200-350 characters).`;
    const model = getGeminiClient();
    logger.debug({ locationName, previousClues, mode, gameTitle, clueNumber, incorrectGuessReasons, prompt }, '[GeoClue] Generating follow-up clue');
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
    let outcomeInstruction = "";
    if (reason === "guessed") {
        // Tell the LLM the win is already announced and ask ONLY for the fun facts/summary.
        outcomeInstruction = `The win has already been announced. Provide ONLY a fun, informative summary with interesting facts about "${locationName}". Do not repeat the winner's name. Do not repeat ${locationName}.`;
    } else if (reason === "timeout") {
        // Explicitly instruct LLM to announce timeout and reveal location at the start
        outcomeInstruction = `Time ran out before anyone guessed correctly. Start your response by announcing the timeout and revealing the location was \"${locationName}\". Then, continue with a fun, informative summary.`;
    } else if (reason === "stopped") {
        // Explicitly instruct LLM to announce stop and reveal location at the start
        outcomeInstruction = `The game was stopped manually. Start your response by stating the game was stopped and revealing the location was \"${locationName}\". Then, continue with a simple, informative summary.`;
    } else {
        outcomeInstruction = `Write a fun, informative summary for the location \"${locationName}\".`; // Default
    }

    const prompt = `You are the Geo-Game Reveal Generator. ${outcomeInstruction}${mode === 'game' && gameTitle ? ` The location is from the video game \"${gameTitle}\". Use search if available to ensure accuracy.` : ''}
- Include a few interesting facts or context about the location.
- Make it engaging and suitable for a Twitch chat audience.
- Respond with a short paragraph (2-4 sentences). Do NOT use markdown formatting.`;
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
