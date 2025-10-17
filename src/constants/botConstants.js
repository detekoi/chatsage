/**
 * Bot-wide constants
 */

// Interval durations (in milliseconds)
export const CHANNEL_SYNC_INTERVAL_MS = 300000; // 5 minutes
export const SECRET_MANAGER_STATUS_LOG_INTERVAL_MS = 60000; // 1 minute
export const SHUTDOWN_FORCE_EXIT_TIMEOUT_MS = 5000; // 5 seconds
export const IRC_CONNECT_MANUAL_TRIGGER_DELAY_MS = 5000; // 5 seconds

// Stop translation trigger phrases
export const STOP_TRANSLATION_TRIGGERS = [
    'stop translating',
    'stop translate'
];

/**
 * Generate mention-based stop triggers for translation
 * @param {string} botUsername - The bot's username
 * @returns {string[]} Array of mention-based stop phrases
 */
export function getMentionStopTriggers(botUsername) {
    const lowerUsername = botUsername.toLowerCase();
    return [
        `@${lowerUsername} stop`,
        `@${lowerUsername} stop translating`,
        `@${lowerUsername} stop translate`,
        `@${lowerUsername}, stop translating`,
    ];
}
