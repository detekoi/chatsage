// src/components/geo/geoPrompts.js
import logger from '../../lib/logger.js';

// --- Prompt Templates ---

/**
 * Generates the prompt for selecting a location.
 * @param {'real' | 'game'} mode - Game mode.
 * @param {GameConfig} config - Game configuration.
 * @param {string | null} gameTitleScope - Specific game title if applicable.
 * @param {string[]} excludedLocations - Locations to avoid selecting.
 * @param {string | null} [sessionRegionScope=null] - Optional user-specified region for this session (real mode only).
 * @returns {string} The location selection prompt.
 */
function getLocationSelectionPrompt(mode, config, gameTitleScope, excludedLocations = [], sessionRegionScope = null) {
    const difficulty = config.difficulty || 'normal';
    let locationScope = 'anywhere in the world';

    if (mode === 'game') {
        locationScope = gameTitleScope ? `within the video game "${gameTitleScope}"` : 'within a popular video game';
    } else {
        // Real mode: Prioritize session scope, then channel config, then global
        if (sessionRegionScope) {
            locationScope = `within the specified region: ${sessionRegionScope}`;
        } else if (config.regionRestrictions && config.regionRestrictions.length > 0) {
            locationScope = `within the channel's configured region(s): ${config.regionRestrictions.join(', ')}`;
        }
        // If neither session nor config region is set, it remains 'anywhere in the world'
    }

    // Add exclusion instruction if list is not empty
    const exclusionInstruction = excludedLocations.length > 0
      ? `\nIMPORTANT: Do NOT select any of the following recently used locations: ${excludedLocations.join(', ')}.`
      : '';

    // Add search instruction for game mode
    const searchInstruction = mode === 'game' ? '\nIf you have access to search, use it to verify the location is from the correct game and is accurate.' : '';

    // Enhanced prompt emphasizing diversity and inclusivity based on spec
    const prompt = `Select a location for a ${difficulty} difficulty geography guessing game.
The location scope is: ${locationScope}.${searchInstruction}
The location should be recognizable but challenging according to the difficulty.
Prioritize diversity: Include locations from all continents, significant indigenous sites (using native names alongside colonial ones if appropriate, e.g., "Uluru / Ayers Rock"), places culturally important to diverse communities, significant LGBTQIA+ historical locations (like Stonewall Inn or specific districts), and locations known for accessibility features.${exclusionInstruction}
Return ONLY the single, most common name of the location. If relevant alternate or indigenous names exist, append them after a slash (/). Example: "Mount Denali / Mount McKinley" or "Mumbai / Bombay". Do not add any other text.`;

    logger.debug({ mode, difficulty, scope: locationScope, sessionRegionScope, excludedCount: excludedLocations.length }, "Generated location selection prompt.");
    return prompt;
}

/**
 * Generates the prompt for the initial clue.
 * @param {string} locationName - The name of the target location.
 * @param {'easy' | 'normal' | 'hard'} difficulty - Game difficulty.
 * @returns {string} The initial clue generation prompt.
 */
function getInitialCluePrompt(locationName, difficulty) {
    const vagueness = difficulty === 'hard' ? 'very vague' : difficulty === 'easy' ? 'slightly vague' : 'moderately vague';

    const prompt = `Generate the first clue for a geography guessing game. The location is "${locationName}".
The clue should be ${vagueness}, hinting at geographic location (continent, climate, major region) or general context (real-world vs. game setting type) without using the location name or obvious unique identifiers.
Keep the clue under 450 characters, ideally shorter (~200-300).
Focus on setting the scene. Be engaging.
Clue:`;
    logger.debug({ locationName, difficulty }, "Generated initial clue prompt.");
    return prompt;
}

/**
 * Generates the prompt for a follow-up clue.
 * @param {string} locationName - The name of the target location.
 * @param {string[]} previousClues - List of clues already given.
 * @param {number} clueNumber - The index of the clue being generated (e.g., 2 for the second clue).
 * @returns {string} The follow-up clue generation prompt.
 */
function getFollowUpCluePrompt(locationName, previousClues, clueNumber) {
    // Determine what aspect to focus on based on clue number (simple example)
    let focusAspect = 'a notable landmark or feature';
    if (clueNumber === 3) focusAspect = 'cultural details, historical context, or climate';
    if (clueNumber >= 4) focusAspect = 'a more specific or well-known fact';

    const prompt = `Generate the next clue for a geography guessing game about "${locationName}".
This is Clue #${clueNumber}.
Previous Clues Given:
${previousClues.map((c, i) => `- Clue ${i + 1}: ${c}`).join('\n')}

The new clue MUST be more specific than the previous ones and reveal new information.
Focus on revealing information about: ${focusAspect}.
Do NOT repeat information already hinted at in previous clues.
Do NOT reveal the location name.
Keep the clue under 450 characters, ideally shorter (~200-300). Be engaging.
New Clue #${clueNumber}:`;
    logger.debug({ locationName, clueNumber }, "Generated follow-up clue prompt.");
    return prompt;
}

/**
 * Generates the prompt for the final reveal information.
 * @param {string} locationName - The name of the target location.
 * @returns {string} The final reveal prompt.
 */
function getFinalRevealPrompt(locationName) {
    // Enhanced prompt based on spec requirements
    const prompt = `The location for the geography game was "${locationName}".
Provide a brief (around 300-400 characters) but engaging and informative description covering:
1.  Key facts (location, type of place).
2.  Historical or cultural significance, including indigenous perspectives or importance to diverse communities if applicable. Mention multiple names (native/colonial) if relevant for context.
3.  Highlight any LGBTQIA+ significance if relevant and well-known (e.g., Stonewall Inn).

Ensure the tone is respectful and celebratory of the location's heritage.
Description:`;
    logger.debug({ locationName }, "Generated final reveal prompt.");
    return prompt;
}

// --- Function Calling Tool Definition ---
const checkGuessTool = {
    functionDeclarations: [
        {
            name: "validate_location_guess",
            description: "Compares a player's guess against the target location. Allows for reasonable spelling errors, partial matches, alternative names (e.g. native/colonial), or closely related places (e.g., guessing a specific landmark within the target city).",
            parameters: {
                type: "OBJECT",
                properties: {
                    target_location: {
                        type: "STRING",
                        description: "The correct target location name (may include '/' separated alternatives like 'Uluru / Ayers Rock')."
                    },
                    player_guess: {
                        type: "STRING",
                        description: "The guess provided by the player."
                    },
                    is_correct: {
                        type: "BOOLEAN",
                        description: "True if the guess is considered correct (allowing for variations), False otherwise."
                    },
                    confidence: {
                        type: "NUMBER",
                        description: "A score from 0.0 (completely wrong) to 1.0 (exact match) indicating how close the guess was. Use values between 0.7-0.9 for near misses or related places."
                    },
                    reasoning: {
                        type: "STRING",
                        description: "Brief explanation for the is_correct decision, especially if allowing a variation (e.g., 'Matches alternate name', 'Correct city landmark', 'Spelling variation')."
                    }
                },
                required: ["target_location", "player_guess", "is_correct", "confidence", "reasoning"]
            }
        }
    ]
};

// Export all prompt functions and tools
export {
    getLocationSelectionPrompt,
    getInitialCluePrompt,
    getFollowUpCluePrompt,
    getFinalRevealPrompt,
    checkGuessTool,
};