// src/handlers/chatMessageHandler.js
// Extracted chat message handler - used by both EventSub webhook and IRC (legacy)
// This is the core message processing pipeline for WildcatSage

import logger from '../lib/logger.js';
import config from '../config/index.js';
import { processMessage as processCommand } from '../components/commands/commandProcessor.js';
import { isChannelAllowed } from '../components/twitch/channelManager.js';
import { notifyUserMessage } from '../components/autoChat/autoChatManager.js';
import { getContextManager } from '../components/context/contextManager.js';
import { getGeoGameManager } from '../components/geo/geoGameManager.js';
import { getTriviaGameManager } from '../components/trivia/triviaGameManager.js';
import { getRiddleGameManager } from '../components/riddle/riddleGameManager.js';
import {
    isPrivilegedUser,
    handlePendingReport,
    handleStopTranslation,
    handleAutoTranslation,
    handleBotMention,
    processGameGuesses
} from './messageHandlers.js';

/**
 * Handle a chat message from any source (EventSub or IRC).
 * 
 * @param {string} channel - Channel name with '#' prefix (e.g. '#channelname')
 * @param {object} tags - IRC-style tags (or converted EventSub tags)
 * @param {string} message - The chat message text
 */
export async function handleChatMessage(channel, tags, message) {
    const botUsername = config.twitch.username?.toLowerCase?.() || '';
    const author = (tags.username || '').toLowerCase();

    // Skip bot's own messages (add to context only)
    if (botUsername && author === botUsername) {
        getContextManager().addMessage(channel.substring(1), tags.username, message, tags).catch(err => {
            logger.error({ err, channel: channel.substring(1), user: tags.username }, 'Error adding self message to context');
        });
        return;
    }

    const cleanChannel = channel.substring(1);

    // Enforce allow-list
    try {
        const isConfiguredChannel = Array.isArray(config.twitch.channels) && config.twitch.channels.map(c => c.toLowerCase()).includes(cleanChannel.toLowerCase());
        let allowed = isConfiguredChannel;
        if (!allowed && config.app.nodeEnv !== 'development') {
            allowed = await isChannelAllowed(cleanChannel);
        }
        if (!allowed) {
            logger.warn(`[ChatHandler] Received message in disallowed channel ${cleanChannel}. Ignoring.`);
            return;
        }
    } catch (allowErr) {
        logger.error({ err: allowErr, channel: cleanChannel }, '[ChatHandler] Error checking allow-list. Ignoring message as a safety measure.');
        return;
    }

    const contextManager = getContextManager();
    const geoManager = getGeoGameManager();
    const triviaManager = getTriviaGameManager();
    const riddleManager = getRiddleGameManager();

    const lowerUsername = tags.username.toLowerCase();
    const displayName = tags['display-name'] || tags.username;
    const isModOrBroadcaster = isPrivilegedUser(tags, cleanChannel);

    // --- Check for pending report responses (Riddle, Trivia, Geo) ---
    const wasReportProcessed = await handlePendingReport({
        message,
        cleanChannel,
        lowerUsername,
        channel,
        tags,
        riddleManager,
        triviaManager,
        geoManager,
        contextManager
    });

    if (wasReportProcessed) {
        return;
    }

    // --- Stop Translation Check ---
    const lowerMessage = message.toLowerCase().trim();
    const wasStopRequest = await handleStopTranslation({
        message,
        lowerMessage,
        cleanChannel,
        lowerUsername,
        channel,
        tags,
        isModOrBroadcaster,
        contextManager
    });

    if (wasStopRequest) {
        return;
    }

    // 1. Add message to context
    contextManager.addMessage(cleanChannel, lowerUsername, message, tags).catch(err => {
        logger.error({ err, channel: cleanChannel, user: lowerUsername }, 'Error adding message to context');
    });

    // Notify AutoChatManager about activity
    try { notifyUserMessage(cleanChannel, Date.now()); } catch (e) { /* ignore */ }

    // 2. Process commands
    let wasTranslateCommand = message.trim().toLowerCase().startsWith('!translate ');
    let wasGeoCommand = message.trim().toLowerCase().startsWith('!geo');
    let wasTriviaCommand = message.trim().toLowerCase().startsWith('!trivia');
    let wasRiddleCommand = message.trim().toLowerCase().startsWith('!riddle');

    if (wasGeoCommand) {
        logger.debug({
            message,
            channel: cleanChannel,
            user: lowerUsername
        }, '!geo command detected in message handler');
    }

    processCommand(cleanChannel, tags, message).catch(err => {
        logger.error({
            err,
            details: err.message,
            stack: err.stack,
            channel: cleanChannel,
            user: lowerUsername,
            commandAttempt: message
        }, 'Error caught directly from processCommand call');
    });

    // --- Check for Game Guesses/Answers ---
    if (!message.startsWith('!') && !wasStopRequest) {
        processGameGuesses({
            message,
            cleanChannel,
            lowerUsername,
            displayName,
            geoManager,
            triviaManager,
            riddleManager
        });
    }

    // --- Automatic Translation Logic ---
    const userState = contextManager.getUserTranslationState(cleanChannel, lowerUsername);
    const wasTranslated = await handleAutoTranslation({
        message,
        cleanChannel,
        lowerUsername,
        channel,
        tags,
        userState,
        wasTranslateCommand
    });

    if (wasTranslated) {
        return;
    }

    // --- Mention or Reply-to-Bot Check ---
    if (!wasTranslateCommand && !wasGeoCommand && !wasTriviaCommand && !wasRiddleCommand && !wasStopRequest) {
        await handleBotMention({
            message,
            cleanChannel,
            lowerUsername,
            displayName,
            channel,
            tags
        });
    }
}
