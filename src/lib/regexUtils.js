// src/lib/regexUtils.js

/**
 * Escapes special regular expression characters in a string so it can be
 * safely used inside a `new RegExp(...)` constructor as a literal match.
 *
 * @param {string} string - The string to escape.
 * @returns {string} The escaped string.
 */
export function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
