// src/components/customCommands/promptResolver.js
import logger from '../../lib/logger.js';
import { generateLiteContent } from '../llm/llmClient.js';
import { smartTruncate, removeMarkdownAsterisks } from '../llm/llmUtils.js';
import { buildSystemInstruction } from '../llm/gemini/prompts.js';
import { getRecentInferences, logInference } from '../llm/inferenceHistoryStorage.js';
import { retrieveMemories, formatMemoriesForPrompt } from '../memory/memoryManager.js';
import { resolveUserIds } from '../../lib/userIdentity.js';

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

    return `--- Your Previous Responses ---\n${numbered}\nDO NOT repeat any of these responses. Rewording the same stories, facts, or jokes counts as repeating — the content must be genuinely new, not just phrased differently. If the task would produce the same content again (e.g. the news hasn't changed), cover a different story, angle, or topic instead.`;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Fetches the channel memories relevant to a prompt. Never throws: a memory
 * failure must not cost the viewer their response.
 * @param {string} channel
 * @param {object} options
 * @param {string} options.prompt - The resolved prompt, matched against memory keys and subjects.
 * @param {string|null} options.chatContext - Recent chat, for weaker key matches.
 * @param {string|null} options.userId - Twitch user ID of the viewer who triggered the prompt.
 * @param {string[]} options.memoryUserIds - User IDs of the viewers the response is for.
 * @param {string[]} options.memoryLogins - Names typed in chat for viewers the response is for;
 *   resolved to user IDs here, and words that aren't logins are ignored.
 * @param {boolean} options.dryRun - Previews don't count as memory usage.
 * @returns {Promise<object[]>}
 */
async function fetchMemories(channel, { prompt, chatContext, userId, memoryUserIds, memoryLogins, dryRun }) {
    try {
        const typedIds = memoryLogins.length > 0 ? [...(await resolveUserIds(memoryLogins)).values()] : [];
        // Facts about whoever triggered the prompt rank below the target's and the prompt's own
        // matches, but none are capped out: a reply that ignores a viewer's allergy is worse than
        // one with a little less lore.
        return await retrieveMemories(channel, {
            text: prompt,
            userId,
            recentText: chatContext,
            focusUserIds: [...memoryUserIds, ...typedIds],
        }, { trackUsage: !dryRun, askerOnlyLimit: Infinity });
    } catch (error) {
        logger.warn({ err: error, channel }, '[Memory] Retrieval failed, generating without channel memory');
        return [];
    }
}

/**
 * Builds the system instruction, optionally appending a language directive.
 * @param {string|null} language - Target language, or null/undefined for English.
 * @param {boolean} isCheckin - Whether this is a check-in command.
 * @param {string|null} channel - Channel name, for the per-channel persona.
 * @returns {string} The full system instruction.
 */
function buildResolverSystemInstruction(language, isCheckin = false, channel = null) {
    const persona = buildSystemInstruction(channel);
    const base = isCheckin ? persona + CHECKIN_HINT : persona;
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
 * @param {string|null} [options.serviceTier=null] - LLM service tier. Defaults to standard because
 *   check-ins and custom commands have a viewer waiting; background callers (timers) pass 'flex'.
 * @param {boolean} [options.dryRun=false] - When true, the recent-inference history is still read
 *   (so the dedup block matches production) but the new response is NOT logged. Used by the
 *   dashboard preview so a preview never suppresses a real response as a "repeat".
 *   Memory retrieval in a dry run doesn't count as usage either.
 * @param {boolean} [options.useMemory=false] - Add the channel's long-term memories relevant to the
 *   prompt (requires `channel`).
 * @param {string|null} [options.userId=null] - Twitch user ID of the viewer who triggered the prompt;
 *   their memories are included after the ones about the target viewers and the prompt itself.
 * @param {string[]} [options.memoryUserIds=[]] - User IDs of the viewers the response is for; every
 *   memory about them ranks as if they were named in the prompt, so the bot doesn't contradict
 *   what it knows (e.g. a viewer's allergies).
 * @param {string[]} [options.memoryLogins=[]] - Same, for viewers named in chat ("!hug @bob").
 * @returns {Promise<string|null>} The generated response, or null on error/empty.
 */
export async function resolvePrompt(prompt, language = null, streamContext = null, isCheckin = false, { channel = null, source = null, chatContext = null, serviceTier = null, dryRun = false, useMemory = false, userId = null, memoryUserIds = [], memoryLogins = [] } = {}) {
    if (!prompt) {
        return '';
    }

    try {
        // Start Firestore read immediately if dedup is enabled — runs in parallel
        // with the synchronous prompt construction below (finding 5).
        const historyPromise = (channel && source)
            ? getRecentInferences(channel, source)
            : Promise.resolve([]);
        const memoryPromise = (useMemory && channel)
            ? fetchMemories(channel, { prompt, chatContext, userId, memoryUserIds, memoryLogins, dryRun })
            : Promise.resolve([]);

        // Build the full prompt with all available context layers
        let fullPrompt = prompt;

        // Append stream context if available
        if (streamContext) {
            fullPrompt += `\n\n--- Stream Context ---\n${streamContext}`;
        }

        // Append recent chat messages so the LLM can riff on the conversation.
        // Framed as background-only: without this the model sometimes abandons
        // the task and replies directly to a chatter.
        if (chatContext) {
            fullPrompt += `\n\n--- Recent Chat (background context only — do NOT reply to or address these messages) ---\n${chatContext}`;
        }

        const memories = await memoryPromise;
        const memoryBlock = formatMemoriesForPrompt(memories);
        if (memoryBlock) {
            fullPrompt += `\n\n${memoryBlock}`;
            logger.info({ channel, source, memoryIds: memories.map(m => m.id), dryRun }, '[Memory] Channel memory added to LLM turn');
        }

        // Await history and append dedup block
        const recentHistory = await historyPromise;
        const historyBlock = formatHistoryForPrompt(recentHistory);
        if (historyBlock) {
            fullPrompt += `\n\n${historyBlock}`;
        }

        // Re-anchor the model on the task after the context blocks.
        if (chatContext || memoryBlock) {
            fullPrompt += `\n\nNow complete the original task stated at the top of this prompt. The sections above are background context only.`;
        }
        if (memoryBlock) {
            fullPrompt += ` Keep the response consistent with the channel memory above, e.g. never offer a viewer food or anything else the memory says they can't have.`;
        }

        logger.debug({ prompt: fullPrompt, language, hasContext: !!streamContext, hasChatContext: !!chatContext, memoryCount: memories.length, historyCount: recentHistory.length, serviceTier, dryRun }, '[PromptResolver] Generating response for custom command prompt');

        const systemInstruction = buildResolverSystemInstruction(language, isCheckin, channel);

        // Google Search grounding is attached but dynamic: the model only searches
        // when the prompt asks for current info (e.g. "look up...", "search for...").
        // Ad-lib prompts skip the search entirely, so latency/cost is unaffected.
        const responseText = await generateLiteContent(fullPrompt, {
            systemInstruction: systemInstruction,
            tools: [{ googleSearch: {} }],
            model: 'main',
            ...(serviceTier ? { serviceTier } : {})
        });

        if (!responseText) {
            logger.warn({ prompt: fullPrompt }, '[PromptResolver] LLM returned empty response');
            return null;
        }

        // Clean up formatting that Twitch doesn't support (markdown links, bold, italic, citations)
        let cleanText = removeMarkdownAsterisks(responseText);

        // Truncate to fit in Twitch chat
        if (cleanText.length > MAX_IRC_MESSAGE_LENGTH) {
            cleanText = smartTruncate(cleanText, MAX_IRC_MESSAGE_LENGTH);
        }

        // Fire-and-forget: log inference for future dedup (only real responses)
        if (channel && source && !dryRun) {
            logInference(channel, source, cleanText);
        }

        return cleanText;
    } catch (error) {
        logger.error({ err: error, prompt }, '[PromptResolver] Error resolving prompt via LLM');
        return null;
    }
}
