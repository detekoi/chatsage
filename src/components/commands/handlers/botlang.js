import logger from '../../../lib/logger.js';
import { getContextManager } from '../../context/contextManager.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { translateText } from '../../../lib/translationUtils.js';

// Helper function removed - permission checking now handled by command system

/**
 * Handler for the !botlang command to set the language for the bot in a channel.
 */
const botLangHandler = {
    name: 'botlang',
    description: 'Set the language for the bot in this channel. Only mods/broadcaster can use this command.',
    usage: '!botlang <language> | !botlang off | !botlang status',
    permission: 'moderator',  // Only mods and broadcasters can use this command
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelName = channel.substring(1);
        const replyToId = user?.id || user?.['message-id'] || null;
        const contextManager = getContextManager();
        
        // Permission checking is now handled by the command system
        
        // Handle different command variations
        if (args.length === 0) {
            // Show current status and usage info
            const currentLanguage = contextManager.getBotLanguage(channelName);
            if (currentLanguage) {
                enqueueMessage(channel, `Bot is currently set to speak ${currentLanguage}. Use "!botlang off" to reset to English or "!botlang <language>" to change.`, { replyToId });
            } else {
                enqueueMessage(channel, `Bot is currently set to speak English (default). Use "!botlang <language>" to change.`, { replyToId });
            }
            return;
        }
        
        const action = args[0].toLowerCase();
        
        // Handle status check
        if (action === 'status') {
            const currentLanguage = contextManager.getBotLanguage(channelName);
            if (currentLanguage) {
                enqueueMessage(channel, `Bot is currently set to speak ${currentLanguage}.`, { replyToId });
            } else {
                enqueueMessage(channel, `Bot is currently set to speak English (default).`, { replyToId });
            }
            return;
        }
        
        // Handle turning off translation
        if (action === 'off' || action === 'default' || action === 'english') {
            contextManager.setBotLanguage(channelName, null);
            enqueueMessage(channel, `Bot language has been reset to English (default).`, { replyToId });
            return;
        }
        
        // Handle setting a new language
        const targetLanguage = args.join(' ');
        
        try {
            // Test the translation to make sure the language is supported
            const testMessage = `This is a test message to verify that "${targetLanguage}" is a supported language.`;
            const translatedTest = await translateText(testMessage, targetLanguage);
            
            if (!translatedTest || translatedTest.trim().length === 0) {
                enqueueMessage(channel, `Sorry, I couldn't translate to "${targetLanguage}". Please check the language name and try again.`, { replyToId });
                return;
            }
            
            // Set the bot language
            contextManager.setBotLanguage(channelName, targetLanguage);
            
            // Confirm in both languages
            const baseConfirm = `Bot language has been set to ${targetLanguage}. All bot responses will now be in ${targetLanguage}. Use "!botlang off" to reset.`;

            // First send in English (skip translation)
            await enqueueMessage(channel, baseConfirm, { replyToId, skipTranslation: true });

            // Then try to send the translated confirmation (skip translation)
            // If translation fails, just skip it - English confirmation is already sent
            try {
                const translatedConfirm = await translateText(baseConfirm, targetLanguage);
                if (translatedConfirm && translatedConfirm.trim().length > 0) {
                    await enqueueMessage(channel, translatedConfirm, { replyToId, skipTranslation: true });
                }
            } catch (confirmError) {
                logger.debug({ err: confirmError, targetLanguage }, 'Failed to translate confirmation message, skipping');
            }
        } catch (error) {
            logger.error({ err: error, targetLanguage }, 'Error setting bot language');
            enqueueMessage(channel, `Sorry, an error occurred while setting the bot language.`, { replyToId });
        }
    },
};

export default botLangHandler;