import logger from '../../../lib/logger.js';
import { getContextManager } from '../../context/contextManager.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { translateText } from '../../../lib/translationUtils.js';

// Helper function to check mod/broadcaster status
function isPrivilegedUser(tags, channelName) {
    const isMod = tags.mod === '1' || tags.badges?.moderator === '1';
    const isBroadcaster = tags.badges?.broadcaster === '1' || tags.username === channelName;
    return isMod || isBroadcaster;
}

/**
 * Handler for the !botlang command to set the language for the bot in a channel.
 */
const botLangHandler = {
    name: 'botlang',
    description: 'Set the language for the bot in this channel. Only mods/broadcaster can use this command.',
    usage: '!botlang <language> | !botlang off | !botlang status',
    permission: 'everyone',  // Allow everyone to pass initial permission check
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelName = channel.substring(1);
        const invokingDisplayName = user['display-name'] || user.username;
        const contextManager = getContextManager();
        
        // Check permissions - only mods and broadcaster can use this
        const isModOrBroadcaster = isPrivilegedUser(user, channelName);
        if (!isModOrBroadcaster) {
            enqueueMessage(channel, `@${invokingDisplayName}, Sorry, only mods or the broadcaster can change the bot's language.`);
            return;
        }
        
        // Handle different command variations
        if (args.length === 0) {
            // Show current status and usage info
            const currentLanguage = contextManager.getBotLanguage(channelName);
            if (currentLanguage) {
                enqueueMessage(channel, `@${invokingDisplayName}, Bot is currently set to speak ${currentLanguage}. Use "!botlang off" to reset to English or "!botlang <language>" to change.`);
            } else {
                enqueueMessage(channel, `@${invokingDisplayName}, Bot is currently set to speak English (default). Use "!botlang <language>" to change.`);
            }
            return;
        }
        
        const action = args[0].toLowerCase();
        
        // Handle status check
        if (action === 'status') {
            const currentLanguage = contextManager.getBotLanguage(channelName);
            if (currentLanguage) {
                enqueueMessage(channel, `@${invokingDisplayName}, Bot is currently set to speak ${currentLanguage}.`);
            } else {
                enqueueMessage(channel, `@${invokingDisplayName}, Bot is currently set to speak English (default).`);
            }
            return;
        }
        
        // Handle turning off translation
        if (action === 'off' || action === 'default' || action === 'english') {
            contextManager.setBotLanguage(channelName, null);
            enqueueMessage(channel, `@${invokingDisplayName}, Bot language has been reset to English (default).`);
            return;
        }
        
        // Handle setting a new language
        const targetLanguage = args.join(' ');
        
        try {
            // Test the translation to make sure the language is supported
            const testMessage = `This is a test message to verify that "${targetLanguage}" is a supported language.`;
            const translatedTest = await translateText(testMessage, targetLanguage);
            
            if (!translatedTest || translatedTest.trim().length === 0) {
                enqueueMessage(channel, `@${invokingDisplayName}, Sorry, I couldn't translate to "${targetLanguage}". Please check the language name and try again.`);
                return;
            }
            
            // Set the bot language
            contextManager.setBotLanguage(channelName, targetLanguage);
            
            // Confirm in both languages
            const confirmMessage = `@${invokingDisplayName}, Bot language has been set to ${targetLanguage}. All bot responses will now be in ${targetLanguage}. Use "!botlang off" to reset.`;
            const translatedConfirm = await translateText(confirmMessage, targetLanguage);
            
            // First send in English (with skipTranslation=true to avoid double translation)
            await enqueueMessage(channel, confirmMessage, true);
            
            // Then send the translated confirmation (also with skipTranslation=true)
            if (translatedConfirm && translatedConfirm.trim().length > 0) {
                await enqueueMessage(channel, translatedConfirm, true);
            }
        } catch (error) {
            logger.error({ err: error, targetLanguage }, 'Error setting bot language');
            enqueueMessage(channel, `@${invokingDisplayName}, Sorry, an error occurred while setting the bot language.`);
        }
    },
};

export default botLangHandler;