import { generateText, generateStructuredJson } from '../llm/geminiClient.js';
import logger from '../../lib/logger.js';
import { getLocationSelectionPrompt } from './geoPrompts.js';
import { GeoCheckGuessSchema } from '../llm/schemaUtils.js';

/**
 * Selects a location for the Geo-Game, avoiding recently used ones.
 * @param {'real'|'game'} mode
 * @param {object} config
 * @param {string|null} gameTitle
 * @param {string[]} excludedLocations - Array of location names to avoid.
 * @param {string|null} [sessionRegionScope=null] - Optional user-specified region for this session (real mode only).
 * @returns {Promise<{name: string, alternateNames?: string[]}|null>}
 */
export async function selectLocation(mode, config = {}, gameTitle = null, excludedLocations = [], sessionRegionScope = null) {
    const prompt = getLocationSelectionPrompt(mode, config, gameTitle, excludedLocations, sessionRegionScope);

    logger.debug({ mode, gameTitle, sessionRegionScope, excludedCount: excludedLocations.length, prompt }, '[GeoLocation] Selecting location');
    try {
        if (mode === 'game') {
            logger.debug(`[GeoLocation] Enabling search tool for game mode location selection: ${gameTitle}`);
        }
        const text = await generateText(prompt, {
            temperature: 0.5, // Moderate temp for variety
            webSearch: mode === 'game'
        });

        if (!text) {
            logger.warn('[GeoLocation] Could not extract text from location selection response');
            return null;
        }
        // Parse: "Location Name/Alt1/Alt2"
        const [name, ...alts] = text.split('/').map(s => s.trim()).filter(Boolean);
        if (!name) {
            logger.warn('[GeoLocation] No valid location name parsed from response', { text });
            return null;
        }
        if (excludedLocations.includes(name)) {
            logger.warn(`[GeoLocation] LLM selected an excluded location ("${name}"). Will likely be retried by manager.`);
        }
        return alts.length ? { name, alternateNames: alts } : { name };
    } catch (error) {
        logger.error({ err: error }, '[GeoLocation] Error selecting location');
        return null;
    }
}

/**
 * Validates a user's guess against the target location using Structured Output.
 * @param {string} targetName
 * @param {string} guess
 * @param {string[]} [alternateNames=[]]
 * @returns {Promise<{is_correct: boolean, confidence?: number, reasoning?: string}|null>}
 */
export async function validateGuess(targetName, guess, alternateNames = []) {
    const prompt = `Target Location: "${targetName}" (Alternates: ${alternateNames.join(', ') || 'none'}). Player Guess: "${guess}".
Task: Validate if the Player Guess accurately matches the Target Location or its known alternates. Prioritize exact (case-insensitive) matches or official alternate names as correct (is_correct: true, confidence: 1.0). Consider common misspellings potentially correct but with slightly lower confidence. If the guess is a landmark within the target city, it might be considered correct with justification. 
Consider these specific cases:
- If the guess is the correct country/continent but not the specific target (e.g., guess 'Australia' for target 'Uluru'), set is_correct: false, confidence: 0.3, reasoning: 'Correct country, but guess is too broad'.
- If the guess is a nearby city/landmark but not the target (e.g., guess 'Sydney Opera House' for target 'Uluru'), set is_correct: false, confidence: 0.2, reasoning: 'Related landmark, but incorrect location'.
- If the guess is a similar landmark but in a different location (e.g., guess 'Eiffel Tower in Las Vegas' for target 'Eiffel Tower in Paris'), set is_correct: false, confidence: 0.1, reasoning: 'Similar landmark exists elsewhere'.
- If the guess is a common misspelling, consider setting is_correct: true, confidence: 0.9, reasoning: 'Correct location (accepted misspelling)'.
Otherwise, mark as incorrect. Provide brief reasoning. Return STRICT JSON.`;

    logger.debug({ targetName, guess, alternateNames }, '[GeoLocation] Validating guess');
    try {
        const parsed = await generateStructuredJson({
            prompt,
            schema: GeoCheckGuessSchema,
            schemaName: 'geo_check_guess',
            temperature: 0.0
        });

        if (parsed) {
            const validationData = {
                is_correct: !!parsed.is_correct,
                confidence: typeof parsed.confidence === 'number' ? parsed.confidence : undefined,
                reasoning: parsed.reasoning || 'No reasoning provided.'
            };
            logger.debug({ validationData }, '[GeoLocation] Parsed structured result for guess validation');
            return validationData;
        }

        return { is_correct: false, reasoning: 'Failed to parse guess validation JSON response.' };
    } catch (error) {
        logger.error({ err: error }, '[GeoLocation] Error validating guess via structured output');
        return { is_correct: false, reasoning: 'API error during guess validation.' };
    }
}
