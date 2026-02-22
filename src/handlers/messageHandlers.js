import logger from '../lib/logger.js';
import config from '../config/index.js';
import { enqueueMessage } from '../lib/ircSender.js';
import { translateText } from '../lib/translationUtils.js';
import { handleStandardLlmQuery } from '../components/llm/llmUtils.js';
import { STOP_TRANSLATION_TRIGGERS, getMentionStopTriggers } from '../constants/botConstants.js';
import { getContextManager } from '../components/context/contextManager.js';
import * as sharedChatManager from '../components/twitch/sharedChatManager.js';
import { getEmoteContextString } from '../lib/geminiEmoteDescriber.js';

/**
 * Helper function for checking mod/broadcaster status
 * @param {Object} tags - Twitch message tags
 * @param {string} channelName - Channel name
 * @returns {boolean} Whether the user is privileged
 */
export function isPrivilegedUser(tags, channelName) {
    const isMod = tags.mod === '1' || tags.badges?.moderator === '1';
    const isBroadcaster = tags.badges?.broadcaster === '1' || tags.username === channelName;
    return isMod || isBroadcaster;
}

/**
 * Handles pending report responses for numeric messages
 * @param {Object} params - Parameters object
 * @returns {Promise<boolean>} True if a report was processed, false otherwise
 */
export async function handlePendingReport({
    message,
    cleanChannel,
    lowerUsername,
    channel,
    tags,
    riddleManager,
    triviaManager,
    geoManager,
    contextManager
}) {
    // Check if message is purely numeric
    if (!/^\d+$/.test(message.trim())) {
        return false;
    }

    logger.debug(`[BotJS] Numeric message "${message.trim()}" from ${lowerUsername} in ${cleanChannel}. Checking for pending report.`);

    // Try Riddle first
    let reportFinalizationResult = await riddleManager.finalizeReportWithRoundNumber(cleanChannel, lowerUsername, message.trim());
    if (reportFinalizationResult.message !== null) {
        enqueueMessage(channel, reportFinalizationResult.message);
        logger.info(`[BotJS] Numeric message from ${lowerUsername} was processed by Riddle finalizeReportWithRoundNumber. Result message: "${reportFinalizationResult.message}"`);
        contextManager.addMessage(cleanChannel, lowerUsername, message, tags).catch(err => {
            logger.error({ err, channel: cleanChannel, user: lowerUsername }, 'Error adding numeric report response to context');
        });
        return true;
    }

    // Try Trivia next
    reportFinalizationResult = await triviaManager.finalizeReportWithRoundNumber(cleanChannel, lowerUsername, message.trim());
    if (reportFinalizationResult.message !== null) {
        enqueueMessage(channel, reportFinalizationResult.message);
        logger.info(`[BotJS] Numeric message from ${lowerUsername} was processed by Trivia finalizeReportWithRoundNumber. Result message: "${reportFinalizationResult.message}"`);
        contextManager.addMessage(cleanChannel, lowerUsername, message, tags).catch(err => {
            logger.error({ err, channel: cleanChannel, user: lowerUsername }, 'Error adding numeric report response to context');
        });
        return true;
    }

    // Try Geo last
    reportFinalizationResult = await geoManager.finalizeReportWithRoundNumber(cleanChannel, lowerUsername, message.trim());
    if (reportFinalizationResult.message !== null) {
        enqueueMessage(channel, reportFinalizationResult.message);
        logger.info(`[BotJS] Numeric message from ${lowerUsername} was processed by Geo finalizeReportWithRoundNumber. Result message: "${reportFinalizationResult.message}"`);
        contextManager.addMessage(cleanChannel, lowerUsername, message, tags).catch(err => {
            logger.error({ err, channel: cleanChannel, user: lowerUsername }, 'Error adding numeric report response to context');
        });
        return true;
    }

    // No pending report found
    logger.debug(`[BotJS] Numeric message "${message.trim()}" from ${lowerUsername}: no pending report found. Continuing to game answer processing.`);
    return false;
}

/**
 * Handles stop translation requests
 * @param {Object} params - Parameters object
 * @returns {Promise<boolean>} True if a stop request was handled, false otherwise
 */
export async function handleStopTranslation({
    message,
    lowerMessage,
    cleanChannel,
    lowerUsername,
    channel,
    tags,
    isModOrBroadcaster,
    contextManager
}) {
    const mentionStopTriggers = getMentionStopTriggers(config.twitch.username);

    let isStopRequest = false;
    let targetUserForStop = lowerUsername; // Default to self
    let stopGlobally = false;

    // Check for command "!translate stop [user|all]"
    if (lowerMessage.startsWith('!translate stop')) {
        isStopRequest = true;
        const parts = message.trim().split(/ +/); // Split by spaces
        if (parts.length > 2) {
            const target = parts[2].toLowerCase().replace(/^@/, '');
            if (target === 'all') {
                if (isModOrBroadcaster) {
                    stopGlobally = true;
                }
                // else: command handler will reject permission
            } else {
                if (isModOrBroadcaster) {
                    targetUserForStop = target;
                }
                // else: command handler will reject permission
            }
        }
        // If just "!translate stop", targetUserForStop remains self
    }
    // Check for natural language stop phrases
    else if (STOP_TRANSLATION_TRIGGERS.some(phrase => lowerMessage === phrase)) {
        isStopRequest = true; // Stop for self
    }
    // Check for mention stop phrases
    else if (mentionStopTriggers.some(phrase => lowerMessage === phrase)) {
        isStopRequest = true; // Stop for self
    }

    if (!isStopRequest) {
        return false;
    }

    logger.info(`[${cleanChannel}] User ${lowerUsername} initiated stop request (target: ${stopGlobally ? 'all' : targetUserForStop}, global: ${stopGlobally}).`);

    // Add message to context before processing stop
    contextManager.addMessage(cleanChannel, lowerUsername, message, tags).catch(err => {
        logger.error({ err, channel: cleanChannel, user: lowerUsername }, 'Error adding stop request to context');
    });

    // Execute stop logic (permission check happens in command/here)
    if (stopGlobally) { // Already checked permission above
        const count = contextManager.disableAllTranslationsInChannel(cleanChannel);
        const replyToId = tags?.id || tags?.['message-id'] || null;
        enqueueMessage(channel, `Okay, stopped translations globally for ${count} user(s).`, { replyToId });
    } else {
        // Check permission if target is not self
        if (targetUserForStop !== lowerUsername && !isModOrBroadcaster) {
            enqueueMessage(channel, `Only mods/broadcaster can stop translation for others.`, { replyToId: tags?.id || tags?.['message-id'] || null });
        } else {
            const wasStopped = contextManager.disableUserTranslation(cleanChannel, targetUserForStop);
            const replyToId = tags?.id || tags?.['message-id'] || null;
            if (targetUserForStop === lowerUsername) { // Message for self stop
                enqueueMessage(channel, wasStopped ? `Translation stopped.` : `Translation was already off.`, { replyToId });
            } else { // Message for mod stopping someone else
                enqueueMessage(channel, wasStopped ? `Stopped translation for ${targetUserForStop}.` : `Translation was already off for ${targetUserForStop}.`, { replyToId });
            }
        }
    }

    return true;
}

/**
 * Handles automatic translation for messages
 * @param {Object} params - Parameters object
 * @returns {Promise<boolean>} True if translation was performed, false otherwise
 */
export async function handleAutoTranslation({
    message,
    cleanChannel,
    lowerUsername,
    channel,
    tags,
    userState,
    wasTranslateCommand
}) {
    // Only translate if enabled and NOT the translate command itself
    if (!userState?.isTranslating || !userState.targetLanguage || wasTranslateCommand) {
        return false;
    }

    logger.debug(`[${cleanChannel}] Translating message from ${lowerUsername} to ${userState.targetLanguage}`);
    try {
        const translatedText = await translateText(message, userState.targetLanguage);
        if (translatedText) {
            const reply = `🌐💬 ${translatedText}`;
            const replyToId = tags?.id || tags?.['message-id'] || null;
            enqueueMessage(channel, reply, { replyToId });
            return true;
        } else {
            logger.warn(`[${cleanChannel}] Failed to translate message for ${lowerUsername}`);
            return false;
        }
    } catch (err) {
        logger.error({ err, channel: cleanChannel, user: lowerUsername }, 'Error during automatic translation.');
        return false;
    }
}

/**
 * Handles bot mentions and replies
 * @param {Object} params - Parameters object
 */
export async function handleBotMention({
    message,
    cleanChannel,
    lowerUsername,
    displayName,
    channel,
    tags
}) {
    const botLower = config.twitch.username.toLowerCase();
    const mentionPrefix = `@${botLower}`;
    const lowerMsg = message.toLowerCase();
    const isMention = lowerMsg.startsWith(mentionPrefix);
    const isReplyToBot = (tags && tags['reply-parent-user-login'] && tags['reply-parent-user-login'].toLowerCase() === botLower) || false;

    if (!isMention && !isReplyToBot) {
        return;
    }

    if (message.startsWith('!')) {
        return; // Skip commands
    }

    let userMessageContent = message;
    if (isMention) {
        userMessageContent = message.substring(mentionPrefix.length).trim();
    }

    if (!userMessageContent) {
        logger.debug(`Ignoring empty mention/reply from ${displayName} in ${cleanChannel}`);
        return;
    }

    // Describe emotes in the original message for LLM context
    const emoteContext = await getEmoteContextString(tags, message);
    const enrichedMessageContent = emoteContext ? `${emoteContext} ${userMessageContent}` : userMessageContent;

    const triggerType = isReplyToBot ? 'reply' : 'mention';
    const replyToId = tags?.id || tags?.['message-id'] || null;

    // Check if channel is in a shared chat session
    const contextManager = getContextManager();
    const broadcasterId = await contextManager.getBroadcasterId(cleanChannel);
    const sessionId = broadcasterId ? sharedChatManager.getSessionForChannel(broadcasterId) : null;

    if (sessionId) {
        // Channel is in a shared chat session
        const channelLogins = sharedChatManager.getSessionChannelLogins(sessionId);

        logger.info({
            channel: cleanChannel,
            user: lowerUsername,
            trigger: triggerType,
            sessionId,
            sharedWith: channelLogins
        }, `[SharedChat:${sessionId}] Bot interaction detected in shared session with: ${channelLogins.join(', ')}`);

        // Use session ID for context instead of single channel
        handleStandardLlmQuery(channel, cleanChannel, displayName, lowerUsername, enrichedMessageContent, triggerType, replyToId, sessionId)
            .catch(err => logger.error({ err, sessionId }, 'Error in async shared chat interaction handler call'));
    } else {
        // Normal single-channel interaction
        logger.info({ channel: cleanChannel, user: lowerUsername, trigger: triggerType }, 'Bot interaction detected, triggering standard LLM query...');

        handleStandardLlmQuery(channel, cleanChannel, displayName, lowerUsername, enrichedMessageContent, triggerType, replyToId)
            .catch(err => logger.error({ err }, 'Error in async interaction handler call'));
    }
}

/**
 * Processes game guesses
 * @param {Object} params - Parameters object
 */
export function processGameGuesses({
    message,
    cleanChannel,
    lowerUsername,
    displayName,
    geoManager,
    triviaManager,
    riddleManager
}) {
    if (message.startsWith('!')) {
        return; // Skip commands
    }

    // Pass potential guess to the game managers
    geoManager.processPotentialGuess(cleanChannel, lowerUsername, displayName, message);
    triviaManager.processPotentialAnswer(cleanChannel, lowerUsername, displayName, message);
    riddleManager.processPotentialAnswer(cleanChannel, lowerUsername, displayName, message);
}
