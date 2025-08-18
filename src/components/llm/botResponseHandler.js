import logger from '../../lib/logger.js';
import { enqueueMessage } from '../../lib/ircSender.js';
import { translateText } from '../../lib/translationUtils.js';
import { getContextManager } from '../context/contextManager.js';

/**
 * Handles sending bot responses with automatic translation based on channel settings.
 * This is a central place for all bot responses to ensure they respect language preferences.
 * 
 * @param {string} channel Channel name with '#'.
 * @param {string} message Message to send.
 * @param {boolean} [skipTranslation=false] If true, skips translation even if channel has a setting.
 * @returns {Promise<void>}
 */
export async function sendBotResponse(channel, message, skipTranslation = false) {
    if (!channel || !message) {
        logger.warn('sendBotResponse called with missing channel or message');
        return;
    }
    
    const channelName = channel.replace(/^#/, ''); // Remove # if present
    const formattedChannel = channel.startsWith('#') ? channel : `#${channel}`; // Ensure channel has #
    
    // The actual translation happens in enqueueMessage, but we log the action here
    const contextManager = getContextManager();
    const botLanguage = contextManager.getBotLanguage(channelName);
    
    if (botLanguage && !skipTranslation) {
        logger.debug(`[${channelName}] Sending message with translation to ${botLanguage}: ${message.substring(0, 30)}...`);
    } else if (skipTranslation && botLanguage) {
        logger.debug(`[${channelName}] Sending message WITHOUT translation (skipped): ${message.substring(0, 30)}...`);
    }
    
    // Use the enqueueMessage function which handles translation internally
    await enqueueMessage(formattedChannel, message, skipTranslation);
}

/**
 * Handles sending responses in both the original language and the translated language.
 * Useful for confirmation messages when setting up translations.
 * 
 * @param {string} channel Channel name with '#'.
 * @param {string} originalMessage Message in original language (usually English).
 * @param {string} targetLanguage Language to translate to.
 * @returns {Promise<void>}
 */
export async function sendBilingualResponse(channel, originalMessage, targetLanguage) {
    if (!channel || !originalMessage || !targetLanguage) {
        logger.warn('sendBilingualResponse called with missing parameters');
        return;
    }
    
    const formattedChannel = channel.startsWith('#') ? channel : `#${channel}`;
    const channelName = channel.replace(/^#/, '');
    
    try {
        // First, send the original message (with skipTranslation to avoid double translation)
        await enqueueMessage(formattedChannel, originalMessage, true);
        
        // Then translate and send the translated version
        logger.debug(`[${channelName}] Translating bilingual message to ${targetLanguage}`);
        const translatedMessage = await translateText(originalMessage, targetLanguage);
        
        if (translatedMessage && translatedMessage.trim().length > 0) {
            await enqueueMessage(formattedChannel, translatedMessage, true);
        } else {
            logger.warn(`[${channelName}] Failed to translate bilingual message to ${targetLanguage}`);
        }
    } catch (error) {
        logger.error({ err: error }, `Error in sendBilingualResponse for ${channelName}`);
    }
}
