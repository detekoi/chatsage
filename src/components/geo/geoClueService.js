import { generateStructuredJson } from '../llm/geminiClient.js';
import logger from '../../lib/logger.js';
import { GeoClueSchema, GeoRevealSchema } from '../llm/schemaUtils.js';

/**
 * Generates the initial clue for a location using Structured Output.
 */
export async function generateInitialClue(locationName, difficulty = 'normal', mode = 'real', gameTitle = null, language = null) {
    const languageDirective = language ? `\nIMPORTANT: Generate the clue entirely in ${language}. Do NOT use English.` : '';
    const prompt = `You are the Geo-Game Clue Generator. Generate the FIRST clue for the location "${locationName}" for a geography guessing game.${mode === 'game' && gameTitle ? ` The location is from the video game "${gameTitle}".` : ''}
Difficulty: ${difficulty}
- Focus on sensory details (sight, sound, smell, feeling) or atmosphere.
- Hint subtly at the region/context.
- Do NOT reveal the location name.
- Return a single engaging sentence in JSON.${languageDirective}`;

    try {
        const parsed = await generateStructuredJson({
            prompt,
            schema: GeoClueSchema,
            schemaName: 'geo_initial_clue',
            tools: mode === 'game' ? [{ googleSearch: {} }] : undefined
        });

        return parsed?.clue_text || null;
    } catch (error) {
        logger.error({ err: error }, '[GeoClue] Error generating initial clue');
        return null;
    }
}

/**
 * Generates a follow-up clue for a location using Structured Output.
 */
export async function generateFollowUpClue(locationName, previousClues = [], mode = 'real', gameTitle = null, clueNumber = 2, incorrectGuessReasons = [], language = null) {
    let reasonGuidance = '';
    if (incorrectGuessReasons && incorrectGuessReasons.length > 0) {
        const uniqueReasons = [...new Set(incorrectGuessReasons)].filter(r => r.trim() !== '');
        if (uniqueReasons.length > 0) {
            reasonGuidance = `
Recent incorrect guesses suggest confusion about: ${uniqueReasons.join('; ')}. Use this insight subtly to guide players.`;
        }
    }

    const languageDirective = language ? `\nIMPORTANT: Generate the clue entirely in ${language}. Do NOT use English.` : '';
    const prompt = `Generate a NEW clue for "${locationName}".${mode === 'game' && gameTitle ? ` Game: "${gameTitle}".` : ''}
Previous clues: ${previousClues.length ? previousClues.map((c, i) => `(${i + 1}) ${c}`).join(' | ') : 'None'}${reasonGuidance}
- Do NOT repeat previous info.
- Make it slightly more specific (unique feature, history, culture).
- Do NOT give away the answer directly.
- Return a single engaging sentence in JSON.${languageDirective}`;

    try {
        const parsed = await generateStructuredJson({
            prompt,
            schema: GeoClueSchema,
            schemaName: 'geo_followup_clue',
            tools: (mode === 'game' || (mode === 'real' && clueNumber > 1)) ? [{ googleSearch: {} }] : undefined
        });

        return parsed?.clue_text || null;
    } catch (error) {
        logger.error({ err: error }, '[GeoClue] Error generating follow-up clue');
        return null;
    }
}

/**
 * Generates a final reveal for the location using Structured Output.
 */
export async function generateFinalReveal(locationName, mode = 'real', gameTitle = null, reason = "unknown", language = null) {
    let outcomeInstruction;
    if (reason === "guessed") {
        outcomeInstruction = `The win has been announced. detailed summary ONLY.`;
    } else if (reason === "timeout") {
        outcomeInstruction = `Time ran out. Announce timeout and reveal location "${locationName}" first.`;
    } else if (reason === "stopped") {
        outcomeInstruction = `Game stopped manually. Announce stop and reveal location "${locationName}" first.`;
    } else {
        outcomeInstruction = `Summary for "${locationName}".`;
    }

    const languageDirective = language ? `\nIMPORTANT: Generate the reveal/summary entirely in ${language}. Do NOT use English.` : '';
    const prompt = `Generate a reveal/summary for "${locationName}". ${outcomeInstruction}
${mode === 'game' && gameTitle ? ` Game: "${gameTitle}".` : ''}
- Interesting facts/context.
- Engaging for Twitch chat.
- Return a short paragraph (2-4 sentences) in JSON.${languageDirective}`;

    try {
        const parsed = await generateStructuredJson({
            prompt,
            schema: GeoRevealSchema,
            schemaName: 'geo_final_reveal',
            tools: mode === 'game' ? [{ googleSearch: {} }] : undefined
        });

        return parsed?.reveal_text || null;
    } catch (error) {
        logger.error({ err: error }, '[GeoClue] Error generating final reveal');
        return null;
    }
}