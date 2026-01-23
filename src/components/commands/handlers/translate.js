import logger from '../../../lib/logger.js';
import { getContextManager } from '../../context/contextManager.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { translateText, parseTranslateCommand } from '../../../lib/translationUtils.js';
import { buildContextPrompt } from '../../llm/geminiClient.js';

// Helper function to check mod/broadcaster status
function isPrivilegedUser(tags, channelName) {
    const isMod = tags.mod === '1' || tags.badges?.moderator === '1';
    const isBroadcaster = tags.badges?.broadcaster === '1' || tags.username === channelName;
    return isMod || isBroadcaster;
}

/**
 * Handler for the !translate command with LLM-based argument parsing.
 */
const translateHandler = {
    name: 'translate',
    description: 'Manage automatic message translation for users.',
    usage: '!translate <language> [user] | !translate <user> <language> | !translate stop [user|all]',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelName = channel.substring(1);
        const invokingUsernameLower = user.username.toLowerCase();
        const invokingDisplayName = user['display-name'] || user.username;
        const replyToId = user?.id || user?.['message-id'] || null;
        const contextManager = getContextManager();
        const isModOrBroadcaster = isPrivilegedUser(user, channelName);

        // --- Input Validation ---
        if (args.length === 0) {
            enqueueMessage(channel, `Usage: !translate <language> [user] | !translate stop [user|all]`, { replyToId });
            return;
        }

        // --- Get chat context for LLM parsing ---
        let chatContext = '';
        try {
            const llmContext = contextManager.getContextForLLM(channelName, invokingUsernameLower, '');
            if (llmContext) {
                chatContext = buildContextPrompt(llmContext);
            }
        } catch (e) {
            logger.warn({ err: e }, 'Could not get chat context for translate command parsing');
        }

        // --- Parse command with LLM ---
        const commandText = args.join(' ');
        const parsed = await parseTranslateCommand(commandText, invokingUsernameLower, chatContext);

        logger.debug({ commandText, parsed, isModOrBroadcaster }, 'Translate command parsed');

        const { action, targetUser, language } = parsed;

        // --- Determine effective target ---
        let targetUsernameLower = targetUser || invokingUsernameLower;

        // --- Permission checks ---
        if (action === 'stop_all') {
            if (!isModOrBroadcaster) {
                enqueueMessage(channel, `Only mods or the broadcaster can stop all translations.`, { replyToId });
                return;
            }
            try {
                const count = contextManager.disableAllTranslationsInChannel(channelName);
                enqueueMessage(channel, `Okay, stopped translations globally for ${count} user(s).`, { replyToId });
            } catch (e) {
                logger.error({ err: e, channel: channelName }, 'Error disabling all translations.');
                enqueueMessage(channel, `Sorry, an error occurred trying to stop all translations.`, { replyToId });
            }
            return;
        }

        // Check permission for targeting other users
        if (targetUsernameLower !== invokingUsernameLower && !isModOrBroadcaster) {
            enqueueMessage(channel, `Only mods or the broadcaster can manage translation for other users.`, { replyToId });
            return;
        }

        // --- Determine display name ---
        const effectiveDisplayName = (targetUsernameLower === invokingUsernameLower)
            ? invokingDisplayName
            : targetUsernameLower;

        // --- Execute Action ---
        try {
            if (action === 'stop') {
                const wasTranslating = contextManager.disableUserTranslation(channelName, targetUsernameLower);
                const stopMessage = wasTranslating
                    ? `Okay, stopped translating messages for ${effectiveDisplayName}.`
                    : `Translation was already off for ${effectiveDisplayName}.`;
                enqueueMessage(channel, stopMessage, { replyToId });
            } else {
                // Enable translation
                if (!language) {
                    enqueueMessage(channel, `Please specify a language. Example: !translate spanish`, { replyToId });
                    return;
                }

                contextManager.enableUserTranslation(channelName, targetUsernameLower, language);

                const baseConfirmation = `Okay, translating messages for ${effectiveDisplayName} into ${language}. Use "!translate stop${targetUsernameLower !== invokingUsernameLower ? ' ' + targetUsernameLower : ''}" to disable.`;
                const translatedConfirmation = await translateText(baseConfirmation, language);

                let finalConfirmation = baseConfirmation;
                if (translatedConfirmation?.trim() && translatedConfirmation.toLowerCase() !== baseConfirmation.toLowerCase()) {
                    finalConfirmation += ` / ${translatedConfirmation}`;
                }

                enqueueMessage(channel, finalConfirmation, { replyToId });
            }
        } catch (e) {
            logger.error({ err: e, action, language, targetUsernameLower }, 'Error executing translate command action.');
            enqueueMessage(channel, `Sorry, an error occurred while processing the translate command.`, { replyToId });
        }
    },
};

export default translateHandler;
