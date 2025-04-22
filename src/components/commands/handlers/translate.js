import logger from '../../../lib/logger.js';
// Need contextManager functions to update user state
import { getContextManager } from '../../context/contextManager.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { translateText } from '../../llm/geminiClient.js';

/**
 * Handler for the !translate command.
 * Enables or disables automatic translation for the invoking user.
 */
const translateHandler = {
    name: 'translate',
    description: 'Turns on/off automatic translation of your messages. Usage: !translate <language> | !translate stop',
    permission: 'everyone', // Allow anyone to use translation for their own messages
    execute: async (context) => {
        const { channel, user, args } = context;
        const commandArg = args[0]?.toLowerCase();
        const channelName = channel.substring(1); // Remove #
        const userName = user.username; // Use lowercase username for state keys
        const displayName = user['display-name'] || user.username;
        const contextManager = getContextManager();

        if (!commandArg) {
            // No argument provided, give usage info
            enqueueMessage(channel, `@${displayName}, Usage: !translate <language> OR !translate stop`);
            return;
        }

        if (commandArg === 'stop') {
            // Disable translation
            try {
                const wasTranslating = contextManager.disableUserTranslation(channelName, userName);
                const stopMessage = wasTranslating
                    ? `@${displayName}, Okay, I will stop translating your messages.`
                    : `@${displayName}, Translation was already off for you.`;
                enqueueMessage(channel, stopMessage);
            } catch (e) {
                logger.error({ err: e, user: userName }, 'Error disabling translation or sending message.');
                enqueueMessage(channel, `@${displayName}, Sorry, there was an error trying to stop translation.`);
            }
        } else {
            // Enable translation (treat arg as language)
            const targetLanguage = args.join(' '); // Allow multi-word languages like "Simplified Chinese"
            try {
                contextManager.enableUserTranslation(channelName, userName, targetLanguage);
                
                // Generate the confirmation message
                const baseConfirmation = `Okay, I will try to translate your next messages into ${targetLanguage}. Use "!translate stop" to disable.`;

                // Attempt to translate the confirmation itself
                const translatedConfirmation = await translateText(baseConfirmation, targetLanguage);

                let finalConfirmation = `@${displayName}, ${baseConfirmation}`;
                if (translatedConfirmation && translatedConfirmation.trim().length > 0) {
                    // Append translated version if successful
                    finalConfirmation += ` / (${translatedConfirmation})`;
                } else {
                    logger.warn(`Could not translate confirmation message into ${targetLanguage}.`);
                }

                enqueueMessage(channel, finalConfirmation);
            } catch (e) {
                logger.error({ err: e, user: userName, language: targetLanguage }, 'Error enabling translation or sending message.');
                enqueueMessage(channel, `@${displayName}, Sorry, there was an error trying to enable translation to ${targetLanguage}.`);
            }
        }
    },
};

export default translateHandler;