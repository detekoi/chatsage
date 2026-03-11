// src/lib/activityLogger.js
// Privacy-respecting activity logger for command and bot interaction tracking.
// Uses a Pino child logger with { type: 'activity' } for easy filtering
// in GCP Cloud Logging: jsonPayload.type = "activity"
//
// IMPORTANT: Never log usernames, user IDs, display names, message content,
// or any PII. Channel names are the streamer's public brand, not PII.

import logger from './logger.js';

// Lazily initialized to avoid issues with test mock hoisting
let _activity;
function getActivityLogger() {
    if (!_activity) _activity = logger.child({ type: 'activity' });
    return _activity;
}

/**
 * Log a command execution.
 * @param {string} channel - Channel name (without '#').
 * @param {string} command - Command name (without '!').
 * @param {'builtin'|'custom'} source - Whether the command is built-in or custom.
 */
export function logCommand(channel, command, source) {
    getActivityLogger().info({ channel, action: 'command', command, source }, `Command !${command} executed`);
}

/**
 * Log a bot interaction (mention or reply).
 * @param {string} channel - Channel name (without '#').
 * @param {'mention'|'reply'} action - Type of interaction.
 */
export function logInteraction(channel, action) {
    getActivityLogger().info({ channel, action }, `Bot ${action} detected`);
}

/**
 * Log a bot response being sent.
 * @param {string} channel - Channel name (without '#').
 * @param {'mention'|'reply'|'command'|'auto_chat'} action - What triggered the response.
 * @param {object} [details] - Optional metadata about the response.
 * @param {number} [details.latencyMs] - LLM round-trip time in milliseconds.
 * @param {number} [details.responseLength] - Character count of the final response.
 * @param {boolean} [details.summarized] - Whether the response was summarized to fit length.
 */
export function logBotResponse(channel, action, details = {}) {
    const logData = { channel, action: 'bot_response', trigger: action };
    if (details.latencyMs != null) logData.latencyMs = details.latencyMs;
    if (details.responseLength != null) logData.responseLength = details.responseLength;
    if (details.summarized != null) logData.summarized = details.summarized;
    getActivityLogger().info(logData, 'Bot response sent');
}
