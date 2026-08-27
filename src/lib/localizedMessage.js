// src/lib/localizedMessage.js
//
// Sends a catalog-backed message to chat.
//
// This is a thin wrapper over enqueueMessage() from ircSender.js — it does not bypass it, and the
// project rule that all bot messages go through enqueueMessage still holds. What it adds is the
// hybrid decision for a *fixed* string:
//
//   no bot language          -> the English fallback, options untouched
//   catalogue hit            -> the localized string, translation skipped (no LLM call)
//   catalogue miss / unknown -> the English fallback, handed to the runtime translator as before
//
// It lives outside ircSender.js on purpose. Handler tests auto-mock ircSender.js wholesale, so a
// helper exported from there would be mocked away and never reach enqueueMessage; from here it
// still calls the mocked enqueueMessage with a plain string, which is what those tests assert on.

import { enqueueMessage } from './ircSender.js';
import { getContextManager } from '../components/context/contextManager.js';
import { t } from './i18n.js';

/**
 * Resolves a catalog key against a channel's configured language.
 * @param {string} channelName Channel name, with or without a leading '#'.
 * @param {string} key Dotted catalog key.
 * @param {object} params Interpolation values.
 * @param {string} fallback The English text, already interpolated.
 * @returns {{ text: string, localized: boolean }} `localized` is true only on a catalogue hit,
 *   meaning the text is already in the target language and needs no further translation.
 */
export function localize(channelName, key, params, fallback) {
    const name = String(channelName || '').replace(/^#/, '');
    let botLanguage = null;
    try {
        // Optional-chained throughout: during a cold start, and under test where the context
        // manager is mocked, this can be absent or incomplete. Falling back to English is correct.
        botLanguage = getContextManager()?.getBotLanguage?.(name) || null;
    } catch {
        // Context manager not initialized yet — English it is.
    }
    if (!botLanguage) return { text: fallback, localized: false };

    const hit = t(key, params, botLanguage);
    if (hit === null) return { text: fallback, localized: false };
    return { text: hit, localized: true };
}

/**
 * Queues a fixed, catalog-backed message for a channel.
 * @param {string} channel Channel name with '#'.
 * @param {string} key Dotted catalog key.
 * @param {object} params Interpolation values for the catalog string.
 * @param {string} fallback The English text, already interpolated.
 * @param {object} [options] Passed through to enqueueMessage (replyToId, etc.).
 */
export async function sendLocalized(channel, key, params, fallback, options) {
    const { text, localized } = localize(channel, key, params, fallback);

    // Options are forwarded untouched unless a catalogue hit lets us skip translation. Keeping the
    // original object identity matters: it is what callers (and their tests) already pass.
    if (localized) {
        return enqueueMessage(channel, text, { ...(options || {}), skipTranslation: true });
    }
    return options === undefined
        ? enqueueMessage(channel, text)
        : enqueueMessage(channel, text, options);
}
