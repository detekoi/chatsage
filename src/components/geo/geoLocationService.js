import { getGeminiClient } from '../llm/geminiClient.js';
import logger from '../../lib/logger.js';

// --- Prompt Templates ---
// (Can be moved to geoPrompts.js later)
function buildLocationSelectionPrompt(mode, config, gameTitle) {
    if (mode === 'real') {
        return `You are the Geo-Game Location Selector. Select a real-world city, landmark, or notable place for a geography guessing game.
- Difficulty: ${config?.difficulty || 'normal'}
- Region Restrictions: ${config?.regionRestrictions?.length ? config.regionRestrictions.join(', ') : 'None'}
- Avoid locations that are too obscure or too famous unless difficulty is set to hard or easy, respectively.
- Respond ONLY with the location name, and if relevant, a pipe (|) separated list of alternate names or spellings (e.g., "New York City|NYC|The Big Apple").`;
    } else if (mode === 'game') {
        return `You are the Geo-Game Location Selector. Select a location, area, or landmark from the video game "${gameTitle}" for a guessing game.
- Difficulty: ${config?.difficulty || 'normal'}
- Avoid spoilers and overly obscure places unless difficulty is hard.
- Respond ONLY with the location name, and if relevant, a pipe (|) separated list of alternate names or spellings (e.g., "Firelink Shrine|Shrine of Link").`;
    } else {
        return 'Invalid mode for location selection.';
    }
}

// --- Function Calling Tool for Guess Validation ---
const checkGuessTool = {
    functionDeclarations: [
        {
            name: "check_guess",
            description: "Strictly compares a player's guess against the target location (and its alternates). Returns true ONLY if the guess is a highly confident match (exact, common misspelling, recognized alternate name, or immediate sub-location like a specific famous landmark within the target city).",
            parameters: {
                type: "OBJECT",
                properties: {
                    target_name: { type: "STRING", description: "The correct target location name (may include '/' separated alternatives)." },
                    guess: { type: "STRING", description: "The user's guess." },
                    alternate_names: { type: "ARRAY", items: { type: "STRING" }, description: "Optional list of official alternate names for the target." },
                    is_correct: { type: "BOOLEAN", description: "Set to true ONLY for a confident match, otherwise false." },
                    confidence: { type: "NUMBER", description: "Score 0.0-1.0. 1.0 for exact/alternate name match. Lower for close but incorrect (e.g., wrong city in correct country). 0.0 for unrelated." },
                    reasoning: { type: "STRING", description: "REQUIRED. Brief reason for the decision (e.g., 'Exact match', 'Matches alternate name', 'Incorrect location', 'Close but wrong city')." }
                },
                required: ["target_name", "guess", "is_correct", "confidence", "reasoning"]
            }
        }
    ]
};

/**
 * Selects a location for the Geo-Game (real or game mode).
 * @param {'real'|'game'} mode
 * @param {object} config
 * @param {string|null} gameTitle
 * @returns {Promise<{name: string, alternateNames?: string[]}|null>}
 */
export async function selectLocation(mode, config = {}, gameTitle = null) {
    const prompt = buildLocationSelectionPrompt(mode, config, gameTitle);
    const model = getGeminiClient();
    logger.debug({ mode, gameTitle, prompt }, '[GeoLocation] Selecting location');
    try {
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: 'Respond ONLY with the location name, and if relevant, a pipe (|) separated list of alternate names. No commentary.' }] }
        });
        const response = result.response;
        if (!response.candidates?.length || !response.candidates[0].content) {
            logger.warn('[GeoLocation] No candidates/content in location selection response');
            return null;
        }
        const text = response.candidates[0].content.parts.map(part => part.text).join('').trim();
        // Parse: "Location Name|Alt1|Alt2"
        const [name, ...alts] = text.split('|').map(s => s.trim()).filter(Boolean);
        if (!name) {
            logger.warn('[GeoLocation] No valid location name parsed from response', { text });
            return null;
        }
        return alts.length ? { name, alternateNames: alts } : { name };
    } catch (error) {
        logger.error({ err: error }, '[GeoLocation] Error selecting location');
        return null;
    }
}

/**
 * Validates a user's guess against the target location using Gemini function calling.
 * @param {string} targetName
 * @param {string} guess
 * @param {string[]} [alternateNames=[]]
 * @returns {Promise<{is_correct: boolean, confidence?: number, reasoning?: string}|null>}
 */
export async function validateGuess(targetName, guess, alternateNames = []) {
    const model = getGeminiClient();
    const prompt = `Target Location: "${targetName}" (Alternates: ${alternateNames.join(', ') || 'none'}). Player Guess: "${guess}".\nTask: Call the 'check_guess' function to validate if the Player Guess accurately matches the Target Location or its known alternates. Prioritize exact (case-insensitive) matches or official alternate names as correct (is_correct: true, confidence: 1.0). Consider common misspellings potentially correct but with slightly lower confidence. If the guess is a landmark within the target city, it might be considered correct with justification. Otherwise, mark as incorrect. Provide brief reasoning.`;
    logger.debug({ targetName, guess, alternateNames }, '[GeoLocation] Validating guess');
    try {
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            tools: checkGuessTool,
            toolConfig: { functionCallingConfig: { mode: 'ANY' } },
            // systemInstruction: { parts: [{ text: 'Your only task is to call the check_guess function based on the user prompt. Do not generate conversational text.' }] }
        });
        const response = result.response;
        const candidate = response?.candidates?.[0];

        if (candidate?.content?.parts?.[0]?.functionCall?.name === 'check_guess') {
            const functionCall = candidate.content.parts[0].functionCall;
            const args = functionCall.args;
            const validationData = {
                is_correct: !!args?.is_correct,
                confidence: typeof args?.confidence === 'number' ? args.confidence : undefined,
                reasoning: args?.reasoning || 'No reasoning provided.'
            };
            logger.debug({ validationData }, '[GeoLocation] Parsed function call result for guess validation');
            return validationData;
        } else {
            logger.warn('[GeoLocation] Model did not make the expected check_guess function call.');
            const textResponse = candidate?.content?.parts?.[0]?.text;
            if (textResponse) logger.debug({ textResponse }, '[GeoLocation] Non-function-call response for guess validation');
            return { is_correct: false, reasoning: 'Model did not call check_guess function as expected.' };
        }
    } catch (error) {
        logger.error({ err: error }, '[GeoLocation] Error validating guess via function call');
        if (error.message?.includes('[400 Bad Request]')) {
             logger.error("Potential issue with function calling payload structure or API compatibility.");
        }
        return { is_correct: false, reasoning: 'API error during guess validation.' };
    }
}
