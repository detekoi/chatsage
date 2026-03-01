// src/lib/redact.js

/**
 * Redacts a string, showing only the first few characters.
 * @param {string} value - The value to redact
 * @param {number} [visibleChars=3] - Number of characters to keep visible
 * @returns {string} Redacted string, e.g. "hen***"
 */
export function redact(value, visibleChars = 3) {
    if (!value) return '[empty]';
    if (typeof value !== 'string') return '[non-string]';
    if (value.length <= visibleChars) return '***';
    return value.slice(0, visibleChars) + '***';
}
