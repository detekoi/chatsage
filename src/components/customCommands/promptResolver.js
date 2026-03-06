// src/components/customCommands/promptResolver.js
import logger from '../../lib/logger.js';
import { getGeminiClient } from '../llm/geminiClient.js';
import { smartTruncate } from '../llm/llmUtils.js';

const BASE_SYSTEM_INSTRUCTION = `You are a fun Twitch chat bot. Respond to the following prompt in a single short message suitable for Twitch chat. Do NOT use markdown formatting (like **bold** or *italics*), as Twitch IRC does not support it. Be concise, engaging, and directly address the prompt. Keep your response under 300 characters.`;

const MAX_IRC_MESSAGE_LENGTH = 450;

/**
 * Builds the system instruction, optionally appending a language directive.
 * @param {string|null} language - Target language, or null/undefined for English.
 * @returns {string} The full system instruction.
 */
function buildSystemInstruction(language) {
    if (!language) {
        return BASE_SYSTEM_INSTRUCTION;
    }
    return `${BASE_SYSTEM_INSTRUCTION} You MUST respond entirely in ${language}.`;
}

/**
 * Sends a resolved prompt template to the LLM to generate a unique response.
 * @param {string} prompt - The prompt with variables already resolved.
 * @param {string|null} [language=null] - Optional target language for the response.
 * @returns {Promise<string>} The generated response, or a fallback string on error.
 */
export async function resolvePrompt(prompt, language = null) {
    if (!prompt) {
        return '';
    }

    try {
        const model = getGeminiClient();

        logger.debug({ prompt, language }, '[PromptResolver] Generating response for custom command prompt');

        const systemInstruction = buildSystemInstruction(language);

        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: systemInstruction }] },
            generationConfig: {
                // Use none thinking to keep responses as fast as possible for chat
                thinkingConfig: { thinkingLevel: 'none' }
            }
        });

        const responseText = result.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!responseText) {
            logger.warn({ prompt }, '[PromptResolver] LLM returned empty response');
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
