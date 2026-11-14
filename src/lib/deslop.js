// src/lib/deslop.js
//
// De-Slop: plain-writing rules for channels that turn the switch on.
//
// The rules are adapted from Humanizer by Siqi Chen
// (https://github.com/blader/humanizer), used under the MIT License. See
// THIRD_PARTY_NOTICES.md for the copyright and permission notice. Humanizer in
// turn draws on Wikipedia's "Signs of AI writing" page, maintained by
// WikiProject AI Cleanup.
//
// Humanizer describes a multi-step rewrite of finished text. A rewrite would
// cost a second LLM request per message, so this module keeps the cost near
// zero instead: a short rule block that rides on prompts the bot already sends,
// and a regex pass for the patterns a regex can find.

import { isDeslopEnabled, isDeslopEnabledById } from '../components/context/responseStyleStorage.js';

/**
 * Appended to the core system instruction, above the persona fence. Kept short
 * because it is sent with every LLM call in a channel that has the switch on.
 */
export const DESLOP_STYLE_BLOCK = `Plain writing (this channel turned it on):
- Say the point directly. No "it's not X, it's Y" contrasts. No question you then answer yourself.
- No opener before the point (Honestly, Look, Here's the thing, Great question). No closing line that repeats the point or offers more help.
- No groups of three for rhythm. No hype or ad words (pivotal, vibrant, testament, stunning, delve, tapestry, game-changer).
- Use is, are, has. Not "serves as" or "stands as". Use commas or periods, never dashes.
- Keep the character's slang and jokes.`;

/** One line for the summarizer, which has no system instruction of its own. */
export const DESLOP_SUMMARY_HINT = 'Keep the wording plain: no dashes, no hype words, no closing remark.';

// Chatbot greetings and praise that sometimes survive in front of the real reply.
const LEADING_RESIDUE = /^\s*(?:great question|good question|certainly|of course|absolutely|sure thing)\s*[!.,:]+\s+(?=\S)/i;

/**
 * Removes the AI-writing tells that need no judgement: dashes used as
 * connectors, curly quotes, and a leading chatbot opener.
 *
 * Hyphens are left alone, so URLs, hyphenated words and negative numbers pass
 * through unchanged.
 *
 * @param {string} text
 * @returns {string}
 */
export function scrubSlop(text) {
    if (typeof text !== 'string' || !text) return text;

    let result = text
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, '\'')
        // A dash between digits is a range: keep it readable as one.
        .replace(/(\d)\s*[–—]\s*(\d)/g, '$1-$2')
        // Any other em or en dash, or a spaced double hyphen, joins two clauses.
        .replace(/\s*[–—]\s*|\s+--\s+/g, ', ')
        // A dash at the start or end, or one next to other punctuation, leaves
        // a stray comma behind.
        .replace(/^, /, '')
        .replace(/, $/, '')
        .replace(/([,.;:!?]), /g, '$1 ');

    const withoutOpener = result.replace(LEADING_RESIDUE, '');
    if (withoutOpener !== result && withoutOpener) {
        result = withoutOpener.charAt(0).toUpperCase() + withoutOpener.slice(1);
    }

    return result;
}

/**
 * Whose setting applies: the host's in a shared-chat session, as in
 * buildSharedSystemInstruction(), otherwise the channel's own.
 * @param {string} channelName
 * @param {string|null} hostChannelId
 * @returns {boolean}
 */
function isDeslopEnabledInScope(channelName, hostChannelId) {
    return hostChannelId ? isDeslopEnabledById(hostChannelId) : isDeslopEnabled(channelName);
}

/**
 * Applies scrubSlop() to LLM-written text if the channel has De-Slop on. Call it
 * on generated text only: quotes, static custom commands and other text that a
 * person typed must reach chat as written.
 *
 * @param {string} channelName - Channel name, with or without '#'.
 * @param {string} text
 * @param {object} [scope]
 * @param {string|null} [scope.hostChannelId] - Host broadcaster ID of the shared-chat
 *   session the text was generated in. The host's setting then decides.
 * @returns {string}
 */
export function applyDeslop(channelName, text, { hostChannelId = null } = {}) {
    return isDeslopEnabledInScope(channelName, hostChannelId) ? scrubSlop(text) : text;
}

/**
 * Options for summarizeText() that carry the channel's style into the summary.
 * @param {string} channelName - Channel name, with or without '#'.
 * @param {object} [scope]
 * @param {string|null} [scope.hostChannelId] - As for applyDeslop().
 * @returns {{styleHint?: string}}
 */
export function summaryStyleOptions(channelName, { hostChannelId = null } = {}) {
    return isDeslopEnabledInScope(channelName, hostChannelId) ? { styleHint: DESLOP_SUMMARY_HINT } : {};
}
