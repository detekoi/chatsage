import logger from '../../../lib/logger.js';
import { getContextManager } from '../../context/contextManager.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { translateText, parseTranslateCommand, SAME_LANGUAGE } from '../../../lib/translationUtils.js';
import { buildContextPrompt } from '../../llm/llmClient.js';
import { isPrivilegedUser } from '../../../lib/permissions.js';
import { sendLocalized } from '../../../lib/localizedMessage.js';
import { normalizeLogin, resolveUserIds } from '../../../lib/userIdentity.js';

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
        // Translation settings are keyed by the immutable Twitch user ID (user.id is the message ID).
        const invokingUserId = user['user-id'] ? String(user['user-id']) : null;
        const invokingDisplayName = user['display-name'] || user.username;
        const replyToId = user?.id || user?.['message-id'] || null;
        const contextManager = getContextManager();
        const isModOrBroadcaster = isPrivilegedUser(user, channelName);

        // --- Input Validation ---
        if (args.length === 0) {
            await sendLocalized(channel, 'cmd.translate.UsageTranslateLanguageUser', {}, `Usage: !translate <language> [user] | !translate stop [user|all]`, { replyToId });
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
        const targetUsernameLower = targetUser
            ? (normalizeLogin(targetUser) || String(targetUser).toLowerCase())
            : invokingUsernameLower;

        // --- Permission checks ---
        if (action === 'stop_all') {
            if (!isModOrBroadcaster) {
                await sendLocalized(channel, 'cmd.translate.OnlyModsOrBroadcaster', {}, `Only mods or the broadcaster can stop all translations.`, { replyToId });
                return;
            }
            try {
                const count = contextManager.disableAllTranslationsInChannel(channelName);
                await sendLocalized(channel, 'cmd.translate.OkayStoppedTranslationsGlobally', { count }, `Okay, stopped translations globally for ${count} user(s).`, { replyToId });
            } catch (e) {
                logger.error({ err: e, channel: channelName }, 'Error disabling all translations.');
                try {
                    await sendLocalized(channel, 'cmd.translate.SorryErrorOccurredTrying', {}, `Sorry, an error occurred trying to stop all translations.`, { replyToId });
                } catch (msgError) {
                    logger.warn({ err: msgError }, '[TranslateCommand] Failed to send error message to chat');
                }
            }
            return;
        }

        // Check permission for targeting other users
        if (targetUsernameLower !== invokingUsernameLower && !isModOrBroadcaster) {
            await sendLocalized(channel, 'cmd.translate.OnlyModsOrBroadcaster2', {}, `Only mods or the broadcaster can manage translation for other users.`, { replyToId });
            return;
        }

        // --- Resolve the target's Twitch user ID ---
        let targetUserId = invokingUserId;
        if (targetUsernameLower !== invokingUsernameLower) {
            const resolved = await resolveUserIds([targetUsernameLower]);
            targetUserId = resolved.get(targetUsernameLower) || null;
            if (!targetUserId) {
                logger.info({ channel: channelName, targetUsername: targetUsernameLower }, '[TranslateCommand] Target user could not be resolved to a Twitch user ID');
                await sendLocalized(channel, 'cmd.translate.UserNotFound', { targetUsername: targetUsernameLower }, `User "${targetUsernameLower}" not found.`, { replyToId });
                return;
            }
        } else if (!invokingUserId) {
            logger.warn({ channel: channelName, user: invokingUsernameLower }, '[TranslateCommand] Message tags carry no user ID; cannot manage translation');
            await sendLocalized(channel, 'cmd.translate.SorryErrorOccurredWhile', {}, `Sorry, an error occurred while processing the translate command.`, { replyToId });
            return;
        }

        // --- Determine display name ---
        const effectiveDisplayName = (targetUsernameLower === invokingUsernameLower)
            ? invokingDisplayName
            : targetUsernameLower;

        // --- Execute Action ---
        try {
            if (action === 'stop') {
                const wasTranslating = contextManager.disableUserTranslation(channelName, targetUserId);
                const stopMessage = wasTranslating
                    ? `Okay, stopped translating messages for ${effectiveDisplayName}.`
                    : `Translation was already off for ${effectiveDisplayName}.`;
                await enqueueMessage(channel, stopMessage, { replyToId });
            } else {
                // Enable translation
                if (!language) {
                    await sendLocalized(channel, 'cmd.translate.PleaseSpecifyLanguageExample', {}, `Please specify a language. Example: !translate spanish`, { replyToId });
                    return;
                }

                contextManager.enableUserTranslation(channelName, targetUserId, targetUsernameLower, language);

                const baseConfirmation = `Okay, translating messages for ${effectiveDisplayName} into ${language}. Use "!translate stop${targetUsernameLower !== invokingUsernameLower ? ' ' + targetUsernameLower : ''}" to disable.`;
                const translatedConfirmation = await translateText(baseConfirmation, language);

                let finalConfirmation = baseConfirmation;
                if (translatedConfirmation && translatedConfirmation !== SAME_LANGUAGE && typeof translatedConfirmation === 'string' && translatedConfirmation.trim() && translatedConfirmation.toLowerCase() !== baseConfirmation.toLowerCase()) {
                    finalConfirmation += ` / ${translatedConfirmation}`;
                }

                await enqueueMessage(channel, finalConfirmation, { replyToId });
            }
        } catch (e) {
            logger.error({ err: e, action, language, targetUsernameLower }, 'Error executing translate command action.');
            try {
                await sendLocalized(channel, 'cmd.translate.SorryErrorOccurredWhile', {}, `Sorry, an error occurred while processing the translate command.`, { replyToId });
            } catch (msgError) {
                logger.warn({ err: msgError }, '[TranslateCommand] Failed to send error message to chat');
            }
        }
    },
};

export default translateHandler;
