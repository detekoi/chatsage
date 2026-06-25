// src/components/customCommands/promptResolver.js
import logger from '../../lib/logger.js';
import { generateLiteContent } from '../llm/gemini/core.js';
import { smartTruncate } from '../llm/llmUtils.js';
import { CHAT_SAGE_SYSTEM_INSTRUCTION } from '../llm/gemini/prompts.js';
import { getRecentInferences, logInference } from '../llm/inferenceHistoryStorage.js';

// Extra context added only for check-in commands to prevent the LLM from
// misinterpreting a user's personal check-in count as being first to stream.
const CHECKIN_HINT = ` If a check-in count or number is mentioned, it refers to the viewer's cumulative all-time personal check-ins.`;

const MAX_IRC_MESSAGE_LENGTH = 450;

// ─── Prompt formatting (finding 10: lives here, not in storage module) ──────

/**
 * Formats an array of previous responses into a prompt-injection string
 * that instructs the LLM not to repeat them.
 *
 * @param {string[]} responses - Array of previous response texts.
 * @returns {string|null} Formatted string for prompt injection, or null if no history.
 */
export function formatHistoryForPrompt(responses) {
    if (!Array.isArray(responses) || responses.length === 0) {
        return null;
    }

    const numbered = responses
        .map((r, i) => `${i + 1}. "${r}"`)
        .join('\n');

    return `--- Your Previous Responses (DO NOT repeat any of these — be creative and unique) ---\n${numbered}`;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Builds the system instruction, optionally appending a language directive.
 * @param {string|null} language - Target language, or null/undefined for English.
 * @param {boolean} isCheckin - Whether this is a check-in command.
 * @returns {string} The full system instruction.
 */
function buildSystemInstruction(language, isCheckin = false) {
    const base = isCheckin ? CHAT_SAGE_SYSTEM_INSTRUCTION + CHECKIN_HINT : CHAT_SAGE_SYSTEM_INSTRUCTION;
    if (!language) {
        return base;
    }
    return `${base} You MUST respond entirely in ${language}.`;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Sends a resolved prompt template to the LLM to generate a unique response.
 * Uses gemini-flash-lite-latest directly for minimal latency.
 *
 * When `channel` and `source` are provided, this function encapsulates the
 * full dedup lifecycle: fetch recent inferences → inject into prompt → generate
 * → log the new response. Callers don't need to touch inferenceHistoryStorage.
 *
 * @param {string} prompt - The prompt with variables already resolved.
 * @param {string|null} [language=null] - Optional target language for the response.
 * @param {string|null} [streamContext=null] - Optional formatted stream context string.
 * @param {boolean} [isCheckin=false] - Whether this is a check-in command.
 * @param {object} [options={}] - Additional options.
 * @param {string|null} [options.channel=null] - Channel name for dedup (enables history read/write).
 * @param {string|null} [options.source=null] - Source key for dedup (use constants from inferenceHistoryStorage).
 * @param {string|null} [options.chatContext=null] - Formatted recent chat messages for conversational flow.
 * @returns {Promise<string|null>} The generated response, or null on error/empty.
 */
export async function resolvePrompt(prompt, language = null, streamContext = null, isCheckin = false, { channel = null, source = null, chatContext = null } = {}) {
    if (!prompt) {
        return '';
    }

    try {
        // Start Firestore read immediately if dedup is enabled — runs in parallel
        // with the synchronous prompt construction below (finding 5).
        const historyPromise = (channel && source)
            ? getRecentInferences(channel, source)
            : Promise.resolve([]);

        // Build the full prompt with all available context layers
        let fullPrompt = prompt;

        // Append stream context if available
        if (streamContext) {
            fullPrompt += `\n\n--- Stream Context ---\n${streamContext}`;
        }

        // Append recent chat messages so the LLM can riff on the conversation
        if (chatContext) {
            fullPrompt += `\n\n--- Recent Chat ---\n${chatContext}`;
        }

        // Await history and append dedup block
        const recentHistory = await historyPromise;
        const historyBlock = formatHistoryForPrompt(recentHistory);
        if (historyBlock) {
            fullPrompt += `\n\n${historyBlock}`;
        }

        logger.debug({ prompt: fullPrompt, language, hasContext: !!streamContext, hasChatContext: !!chatContext, historyCount: recentHistory.length }, '[PromptResolver] Generating response for custom command prompt');

        const systemInstruction = buildSystemInstruction(language, isCheckin);

        const responseText = await generateLiteContent(fullPrompt, {
            systemInstruction: systemInstruction
        });

        if (!responseText) {
            logger.warn({ prompt: fullPrompt }, '[PromptResolver] LLM returned empty response');
            return null;
        }

        // Clean up formatting that Twitch doesn't support
        let cleanText = responseText.trim();
        cleanText = cleanText.replace(/\*\*/g, ''); // Remove bold asterisks
        cleanText = cleanText.replace(/_ /g, ' '); // Sometime models try italics

        // Truncate to fit in Twitch chat
        if (cleanText.length > MAX_IRC_MESSAGE_LENGTH) {
            cleanText = smartTruncate(cleanText, MAX_IRC_MESSAGE_LENGTH);
        }

        // Fire-and-forget: log inference for future dedup (only real responses)
        if (channel && source) {
            logInference(channel, source, cleanText);
        }

        return cleanText;
    } catch (error) {
        logger.error({ err: error, prompt }, '[PromptResolver] Error resolving prompt via Gemini');
        return null;
    }
}
