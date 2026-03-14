// src/components/customCommands/promptResolver.js
import logger from '../../lib/logger.js';
import { getGenAIInstance } from '../llm/gemini/core.js';
import { smartTruncate } from '../llm/llmUtils.js';

const FLASH_LITE_MODEL = 'gemini-3.1-flash-lite-preview';

const BASE_SYSTEM_INSTRUCTION = `You are a Twitch chat bot. Respond to the following prompt in a single short message suitable for Twitch chat. No markdown formatting. Be concise and match the tone requested in the prompt. Keep your response under 300 characters.`;

// Extra context added only for check-in commands to prevent the LLM from
// misinterpreting a user's personal check-in count as being first to stream.
const CHECKIN_HINT = ` If a check-in count or number is mentioned, it refers to the viewer's cumulative all-time personal check-ins.`;

const MAX_IRC_MESSAGE_LENGTH = 450;

/**
 * Builds the system instruction, optionally appending a language directive.
 * @param {string|null} language - Target language, or null/undefined for English.
 * @returns {string} The full system instruction.
 */
function buildSystemInstruction(language, isCheckin = false) {
    const base = isCheckin ? BASE_SYSTEM_INSTRUCTION + CHECKIN_HINT : BASE_SYSTEM_INSTRUCTION;
    if (!language) {
        return base;
    }
    return `${base} You MUST respond entirely in ${language}.`;
}

/**
 * Sends a resolved prompt template to the LLM to generate a unique response.
 * Uses gemini-3.1-flash-lite-preview directly for minimal latency.
 * @param {string} prompt - The prompt with variables already resolved.
 * @param {string|null} [language=null] - Optional target language for the response.
 * @param {string|null} [streamContext=null] - Optional formatted stream context string.
 * @returns {Promise<string>} The generated response, or a fallback string on error.
 */
export async function resolvePrompt(prompt, language = null, streamContext = null, isCheckin = false) {
    if (!prompt) {
        return '';
    }

    try {
        const ai = getGenAIInstance();

        // Append stream context to the prompt if available
        const fullPrompt = streamContext
            ? `${prompt}\n\n--- Stream Context ---\n${streamContext}`
            : prompt;

        logger.debug({ prompt: fullPrompt, language, hasContext: !!streamContext }, '[PromptResolver] Generating response for custom command prompt');

        const systemInstruction = buildSystemInstruction(language, isCheckin);

        const result = await ai.models.generateContent({
            model: FLASH_LITE_MODEL,
            contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
            config: {
                systemInstruction: { parts: [{ text: systemInstruction }] },
                temperature: 1.5,
            }
        });

        const responseText = result.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!responseText) {
            logger.warn({ prompt: fullPrompt }, '[PromptResolver] LLM returned empty response');
            return "Sorry, I couldn't think of a good response right now.";
        }

        // Clean up formatting that Twitch doesn't support
        let cleanText = responseText.trim();
        cleanText = cleanText.replace(/\*\*/g, ''); // Remove bold asterisks
        cleanText = cleanText.replace(/_ /g, ' '); // Sometime models try italics

        // Truncate to fit in Twitch chat
        if (cleanText.length > MAX_IRC_MESSAGE_LENGTH) {
            cleanText = smartTruncate(cleanText, MAX_IRC_MESSAGE_LENGTH);
        }

        return cleanText;
    } catch (error) {
        logger.error({ err: error, prompt }, '[PromptResolver] Error resolving prompt via Gemini');
        return 'An error occurred while generating the response for this command.';
    }
}
