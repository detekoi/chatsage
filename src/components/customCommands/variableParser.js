// src/components/customCommands/variableParser.js
import logger from '../../lib/logger.js';

/**
 * Parses and resolves variables in a custom command response template.
 * Variables use the $(variableName) syntax.
 * 
 * Supported variables:
 *   $(user)          - Display name of the user who triggered the command
 *   $(channel)       - Channel name
 *   $(args)          - All arguments as a single string
 *   $(1), $(2), ...  - Individual arguments by position
 *   $(count)         - Command use count (auto-incremented)
 *   $(random X-Y)    - Random integer between X and Y (inclusive)
 *   $(uptime)        - Stream uptime (if live)
 *   $(game)          - Current game title
 *   $(followage)     - How long the user has followed the channel
 * 
 * @param {string} template - The response template with variables.
 * @param {object} context - Context for variable resolution.
 * @param {string} context.user - Display name of the triggering user.
 * @param {string} context.channel - Channel name (without #).
 * @param {string[]} context.args - Command arguments.
 * @param {number} [context.useCount] - Current use count of the command.
 * @param {object} [context.streamContext] - Stream context from contextManager.
 * @param {Function} [context.getFollowage] - Async function to get followage info.
 * @returns {Promise<string>} The resolved response string.
 */
export async function parseVariables(template, context) {
    if (!template || typeof template !== 'string') {
        return '';
    }

    const { user = '', channel = '', args = [], useCount = 0, streamContext = null, getFollowage = null } = context;

    // Match all $(variableName) patterns, including those with spaces and arguments
    const variablePattern = /\$\(([^)]+)\)/g;

    // Collect all matches and resolve them
    const matches = [];
    let match;
    while ((match = variablePattern.exec(template)) !== null) {
        matches.push({
            fullMatch: match[0],
            variableContent: match[1].trim(),
            index: match.index,
        });
    }

    if (matches.length === 0) {
        return template; // No variables to resolve
    }

    // Resolve all variables (some may be async)
    let result = template;

    // Process in reverse order to maintain correct indices during replacement
    for (let i = matches.length - 1; i >= 0; i--) {
        const { fullMatch, variableContent } = matches[i];
        let resolved;

        try {
            resolved = await _resolveVariable(variableContent, {
                user,
                channel,
                args,
                useCount,
                streamContext,
                getFollowage,
            });
        } catch (error) {
            logger.warn({ variable: variableContent, error: error.message },
                '[VariableParser] Error resolving variable, using empty string');
            resolved = '';
        }

        result = result.replace(fullMatch, resolved);
    }

    return result;
}

/**
 * Resolves a single variable to its value.
 * @param {string} variableContent - The content inside $(), e.g., "user", "random 1-100".
 * @param {object} context - Resolution context.
 * @returns {Promise<string>} Resolved value.
 */
async function _resolveVariable(variableContent, context) {
    const { user, channel, args, useCount, streamContext, getFollowage } = context;
    const lowerContent = variableContent.toLowerCase();

    // $(user)
    if (lowerContent === 'user') {
        return user || 'unknown';
    }

    // $(channel)
    if (lowerContent === 'channel') {
        return channel || 'unknown';
    }

    // $(args)
    if (lowerContent === 'args') {
        return args.join(' ') || '';
    }

    // $(1), $(2), ... — positional arguments
    const argMatch = variableContent.match(/^(\d+)$/);
    if (argMatch) {
        const argIndex = parseInt(argMatch[1], 10) - 1; // 1-indexed to 0-indexed
        return args[argIndex] || '';
    }

    // $(count)
    if (lowerContent === 'count') {
        return String(useCount || 0);
    }

    // $(random X-Y)
    const randomMatch = variableContent.match(/^random\s+(\d+)-(\d+)$/i);
    if (randomMatch) {
        const min = parseInt(randomMatch[1], 10);
        const max = parseInt(randomMatch[2], 10);
        if (min <= max) {
            return String(Math.floor(Math.random() * (max - min + 1)) + min);
        }
        return String(min); // Fallback if min > max
    }

    // $(uptime)
    if (lowerContent === 'uptime') {
        return _resolveUptime(streamContext);
    }

    // $(game)
    if (lowerContent === 'game') {
        return streamContext?.game && streamContext.game !== 'N/A'
            ? streamContext.game
            : 'Unknown';
    }

    // $(followage)
    if (lowerContent === 'followage') {
        if (typeof getFollowage === 'function') {
            try {
                return await getFollowage(user, channel);
            } catch (error) {
                logger.warn({ error: error.message }, '[VariableParser] Failed to resolve $(followage)');
                return 'unable to check followage';
            }
        }
        return 'followage unavailable';
    }

    // Unknown variable — return it as-is so the user can see the mistake
    logger.debug({ variable: variableContent }, '[VariableParser] Unknown variable, returning as-is');
    return `$(${variableContent})`;
}

/**
 * Resolves uptime from stream context.
 * @param {object|null} streamContext - Stream context snapshot.
 * @returns {string} Human-readable uptime or 'offline'.
 */
function _resolveUptime(streamContext) {
    if (!streamContext?.startedAt) {
        return 'offline';
    }

    const startedAt = new Date(streamContext.startedAt);
    if (isNaN(startedAt.getTime())) {
        return 'offline';
    }

    const now = new Date();
    const diffMs = now - startedAt;

    return formatDuration(diffMs);
}

/**
 * Formats a duration in milliseconds to a human-readable string.
 * @param {number} ms - Duration in milliseconds.
 * @returns {string} Formatted duration string (e.g., "2h 30m").
 */
export function formatDuration(ms) {
    if (ms < 0) return '0m';

    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);

    return parts.join(' ');
}

/**
 * Formats a follow duration from a followed_at timestamp to a human-readable string.
 * @param {string} followedAt - ISO 8601 timestamp of when the follow started.
 * @returns {string} Formatted follow duration (e.g., "2 years 3 months").
 */
export function formatFollowAge(followedAt) {
    const followDate = new Date(followedAt);
    if (isNaN(followDate.getTime())) {
        return 'unknown';
    }

    const now = new Date();

    let years = now.getFullYear() - followDate.getFullYear();
    let months = now.getMonth() - followDate.getMonth();
    let days = now.getDate() - followDate.getDate();

    // Adjust for negative days
    if (days < 0) {
        months--;
        const prevMonth = new Date(now.getFullYear(), now.getMonth(), 0);
        days += prevMonth.getDate();
    }

    // Adjust for negative months
    if (months < 0) {
        years--;
        months += 12;
    }

    const parts = [];
    if (years > 0) parts.push(`${years} year${years !== 1 ? 's' : ''}`);
    if (months > 0) parts.push(`${months} month${months !== 1 ? 's' : ''}`);
    if (days > 0 && years === 0) parts.push(`${days} day${days !== 1 ? 's' : ''}`); // Only show days if less than a year

    return parts.length > 0 ? parts.join(' ') : 'just now';
}
