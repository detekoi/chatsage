import { getGeminiClient } from '../llm/geminiClient.js';
import logger from '../../lib/logger.js';
import { getLocationSelectionPrompt } from './geoPrompts.js';



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
    
    // Create a fresh model instance without any system instruction to avoid token overhead
    const { getGenAIInstance } = await import('../llm/geminiClient.js');
    const genAI = getGenAIInstance();
    const model = genAI.getGenerativeModel({
        model: process.env.GEMINI_MODEL_ID || 'gemini-2.5-flash',
        generationConfig: {
            temperature: 0.5, // Moderate temp for variety
            candidateCount: 1
        }
    });
    
    logger.debug({ mode, gameTitle, sessionRegionScope, excludedCount: excludedLocations.length, prompt }, '[GeoLocation] Selecting location');
    try {
        const generateOptions = {
            contents: [{ role: 'user', parts: [{ text: prompt }] }]
        };
        if (mode === 'game') {
            logger.debug(`[GeoLocation] Enabling search tool for game mode location selection: ${gameTitle}`);
            generateOptions.tools = [{ googleSearch: {} }];
        }
        const result = await model.generateContent(generateOptions);
        const response = result.response;
        const candidate = response?.candidates?.[0];
        
        // Temporary detailed logging to tune token limits
        logger.debug({
            usageMetadata: result.response?.usageMetadata,
            finishReason: candidate?.finishReason
        }, '[GeoLocation] Token usage debug');
        
        if (candidate?.finishReason !== 'STOP') {
            logger.warn({ finishReason: candidate?.finishReason }, '[GeoLocation] Non-STOP finish reason');
        }
        
        if (!candidate) {
            logger.warn('[GeoLocation] No candidate found in location selection response');
            return null;
        }
        
        
        // Robust text extraction similar to geminiClient.js approach
        let text = null;
        const parts = candidate?.content?.parts;
        if (Array.isArray(parts) && parts.length > 0) {
            text = parts.map(part => part.text || '').join('').trim();
        }
        
        // Fallback text extraction methods
        if (!text && candidate && typeof candidate.text === 'string') {
            text = candidate.text.trim();
        }
        if (!text && response && typeof response.text === 'function') {
            const responseText = response.text();
            text = typeof responseText === 'string' ? responseText.trim() : null;
        }
        if (!text && response && typeof response.text === 'string') {
            text = response.text.trim();
        }
        
        if (!text) {
            logger.warn('[GeoLocation] Could not extract text from Gemini response');
            // Debug: Log the actual response to see what's happening
            logger.warn({ 
                finishReason: candidate.finishReason,
                candidateContent: candidate.content,
                hasContent: !!candidate.content,
                hasParts: !!candidate.content?.parts,
                partsLength: candidate.content?.parts?.length || 0
            }, '[GeoLocation] Debug: Response details');
            return null;
        }
        // Parse: "Location Name/Alt1/Alt2"
        const [name, ...alts] = text.split('/').map(s => s.trim()).filter(Boolean);
        if (!name) {
            logger.warn('[GeoLocation] No valid location name parsed from response', { text });
            return null;
        }
        // Optional: Double-check if LLM ignored exclusion instruction (basic check)
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
 * Validates a user's guess against the target location using Gemini function calling.
 * @param {string} targetName
 * @param {string} guess
 * @param {string[]} [alternateNames=[]]
 * @returns {Promise<{is_correct: boolean, confidence?: number, reasoning?: string}|null>}
 */
export async function validateGuess(targetName, guess, alternateNames = []) {
    const model = getGeminiClient();
    const prompt = `Target Location: "${targetName}" (Alternates: ${alternateNames.join(', ') || 'none'}). Player Guess: "${guess}".\nTask: Call the 'check_guess' function to validate if the Player Guess accurately matches the Target Location or its known alternates. Prioritize exact (case-insensitive) matches or official alternate names as correct (is_correct: true, confidence: 1.0). Consider common misspellings potentially correct but with slightly lower confidence. If the guess is a landmark within the target city, it might be considered correct with justification. 
    Consider these specific cases:
    - If the guess is the correct country/continent but not the specific target (e.g., guess 'Australia' for target 'Uluru'), set is_correct: false, confidence: 0.3, reasoning: 'Correct country, but guess is too broad'.
    - If the guess is a nearby city/landmark but not the target (e.g., guess 'Sydney Opera House' for target 'Uluru'), set is_correct: false, confidence: 0.2, reasoning: 'Related landmark, but incorrect location'.
    - If the guess is a similar landmark but in a different location (e.g., guess 'Eiffel Tower in Las Vegas' for target 'Eiffel Tower in Paris'), set is_correct: false, confidence: 0.1, reasoning: 'Similar landmark exists elsewhere'.
    - If the guess is a common misspelling, consider setting is_correct: true, confidence: 0.9, reasoning: 'Correct location (accepted misspelling)'.
    Otherwise, mark as incorrect. Provide brief reasoning.`;
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
