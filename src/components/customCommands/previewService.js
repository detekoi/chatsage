// src/components/customCommands/previewService.js
// Generates a one-off "what would the bot say?" sample for the dashboard.
//
// Each kind mirrors its production caller as closely as possible — same
// variable context shape, same stream/chat context, same dedup history — so
// the preview is representative of a real inference. The one deliberate
// difference is that nothing is persisted: the response is not logged to the
// inference history (dryRun), no use counters move, and nothing is sent to chat.

import logger from '../../lib/logger.js';
import { parseVariables } from './variableParser.js';
import { resolvePrompt } from './promptResolver.js';
import { getContextManager } from '../context/contextManager.js';
import { buildContextPrompt } from '../llm/gemini/prompts.js';
import { CHECKIN_SOURCE, customCommandSource, timerSource } from '../llm/inferenceHistoryStorage.js';
import { buildTimerStreamContext } from '../timers/timerManager.js';

/** Preview kinds, matching the three AI-authored features in the dashboard. */
export const PREVIEW_KINDS = ['command', 'timer', 'checkin'];

/** Mirrors the dashboard/API limit for AI prompt text. */
export const MAX_PREVIEW_PROMPT_LENGTH = 500;

/** Upper bound for the optional sample arguments a preview may supply. */
export const MAX_PREVIEW_ARGS_LENGTH = 200;

const NAME_PATTERN = /^[a-z0-9_]{1,25}$/;

// A preview has no triggering viewer, so $(followage) gets a stand-in rather
// than a Helix lookup for the broadcaster following their own channel.
const SAMPLE_FOLLOWAGE = '1 year, 2 months';

/**
 * Validates a preview request body. Returns an error string or null when valid.
 * @param {object} body
 * @returns {string|null}
 */
export function validatePreviewRequest(body) {
    if (!body || typeof body !== 'object') return 'Request body must be a JSON object.';
    if (typeof body.channel !== 'string' || !NAME_PATTERN.test(body.channel)) return 'Invalid channel.';
    if (!PREVIEW_KINDS.includes(body.kind)) return `kind must be one of: ${PREVIEW_KINDS.join(', ')}.`;
    if (typeof body.prompt !== 'string' || body.prompt.trim() === '') return 'prompt is required.';
    if (body.prompt.length > MAX_PREVIEW_PROMPT_LENGTH) return `prompt must be ${MAX_PREVIEW_PROMPT_LENGTH} characters or fewer.`;
    if (body.name !== undefined && body.name !== null && (typeof body.name !== 'string' || !NAME_PATTERN.test(body.name))) return 'Invalid name.';
    if (body.args !== undefined && body.args !== null && (typeof body.args !== 'string' || body.args.length > MAX_PREVIEW_ARGS_LENGTH)) {
        return `args must be a string of ${MAX_PREVIEW_ARGS_LENGTH} characters or fewer.`;
    }
    return null;
}

function safeLlmContext(contextManager, ...args) {
    const channel = args[0];
    try {
        return contextManager.getContextForLLM(...args);
    } catch (err) {
        logger.debug({ err, channel }, '[Preview] Could not gather LLM context, proceeding without it');
        return null;
    }
}

/**
 * Generates a sample inference for an AI custom command, AI timer, or AI check-in.
 *
 * @param {object} params
 * @param {string} params.channel - Channel login (without '#'). Must already be authenticated by the caller.
 * @param {'command'|'timer'|'checkin'} params.kind
 * @param {string} params.prompt - The AI prompt template, with $(...) variables unresolved.
 * @param {string|null} [params.name] - Command/timer name, used for the dedup history source key.
 * @param {string} [params.args] - Sample arguments for $(args), commands only.
 * @returns {Promise<{ kind: string, resolvedPrompt: string, response: string|null, language: string|null }>}
 */
export async function generatePreview({ channel, kind, prompt, name = null, args = '' }) {
    const contextManager = getContextManager();
    const botLanguage = contextManager.getBotLanguage(channel) || null;
    // The broadcaster stands in for the triggering viewer.
    const sampleUser = channel;
    const argList = (args || '').trim() ? args.trim().split(/\s+/) : [];
    const streamContext = contextManager.getStreamContextSnapshot(channel);

    let resolvedPrompt;
    let response;

    switch (kind) {
        case 'command': {
            // Mirrors commandProcessor: variables from the viewer + stream, chat
            // context, and no separate stream-context block for the LLM.
            resolvedPrompt = await parseVariables(prompt, {
                user: sampleUser,
                channel,
                args: argList,
                useCount: 1,
                streamContext,
                getFollowage: async () => SAMPLE_FOLLOWAGE,
                userPronouns: null,
            });
            const llmContext = safeLlmContext(contextManager, channel, sampleUser, '');
            response = await resolvePrompt(resolvedPrompt, botLanguage, null, false, {
                channel,
                source: customCommandSource(name || 'preview'),
                chatContext: llmContext?.recentChatHistory || null,
                dryRun: true,
            });
            break;
        }
        case 'timer': {
            // Mirrors timerManager.fireTimer + generatePromptTimerOutput.
            resolvedPrompt = await parseVariables(prompt, {
                user: '',
                channel,
                args: [],
                useCount: 0,
                streamContext,
            });
            const llmContext = safeLlmContext(contextManager, channel, 'system', 'timer');
            response = await resolvePrompt(resolvedPrompt, botLanguage, buildTimerStreamContext(llmContext), false, {
                channel,
                source: timerSource(name || 'preview'),
                chatContext: llmContext?.recentChatHistory || null,
                serviceTier: 'flex',
                dryRun: true,
            });
            break;
        }
        case 'checkin': {
            // Mirrors checkinHandler: full prompt-style stream context and the
            // check-in hint in the system instruction.
            resolvedPrompt = await parseVariables(prompt, {
                user: sampleUser,
                channel,
                args: [],
                useCount: 1,
                checkinCount: 1,
                userPronouns: null,
            });
            const llmContext = safeLlmContext(contextManager, channel, sampleUser, '', null);
            response = await resolvePrompt(resolvedPrompt, botLanguage, llmContext ? buildContextPrompt(llmContext) : null, true, {
                channel,
                source: CHECKIN_SOURCE,
                chatContext: llmContext?.recentChatHistory || null,
                dryRun: true,
            });
            break;
        }
        default:
            throw new Error(`Unknown preview kind: ${kind}`);
    }

    logger.info({ channel, kind, name, hasResponse: !!response }, '[Preview] Generated dashboard preview');
    return { kind, resolvedPrompt, response: response || null, language: botLanguage };
}
