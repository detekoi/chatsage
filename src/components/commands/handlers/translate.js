import logger from '../../../lib/logger.js';
// Need contextManager functions to update user state
import { getContextManager } from '../../context/contextManager.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { translateText } from '../../llm/geminiClient.js';

// Helper function to check mod/broadcaster status
function isPrivilegedUser(tags, channelName) {
    const isMod = tags.mod === '1' || tags.badges?.moderator === '1';
    const isBroadcaster = tags.badges?.broadcaster === '1' || tags.username === channelName;
    return isMod || isBroadcaster;
}

/**
 * Handler for the !translate command with moderator controls.
 */
const translateHandler = {
    name: 'translate',
    description: 'Manage automatic message translation for users.',
    usage: '!translate <lang> | !translate stop | !translate <lang|stop> [user] (mods) | !translate stop all (mods)',
    // Permission check will be done inside execute based on args
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, args } = context;
        const commandArg = args[0]?.toLowerCase();
        const targetLanguageOrStop = commandArg; // e.g., "german" or "stop"
        let targetUsername = args[1]?.toLowerCase().replace(/^@/, ''); // e.g., "otheruser" (remove leading @ if present)

        const channelName = channel.substring(1);
        const invokingUsernameLower = user.username; // Lowercase username of the person typing the command
        const invokingDisplayName = user['display-name'] || user.username;
        const contextManager = getContextManager();
        const isModOrBroadcaster = isPrivilegedUser(user, channelName);

        // --- Input Validation & Permission Checks ---

        if (!targetLanguageOrStop) {
            enqueueMessage(channel, `@${invokingDisplayName}, Usage: !translate <language> | !translate stop | !translate <lang> <user> | !translate stop <user> | !translate stop all (Mods/Broadcaster)`);
            return;
        }

        const isStopAction = targetLanguageOrStop === 'stop';

        // Handling !translate stop all (requires privileges)
        if (isStopAction && targetUsername === 'all') {
            if (!isModOrBroadcaster) {
                enqueueMessage(channel, `@${invokingDisplayName}, Only mods or the broadcaster can stop all translations.`);
                return;
            }
            try {
                const count = contextManager.disableAllTranslationsInChannel(channelName);
                enqueueMessage(channel, `@${invokingDisplayName}, Okay, stopped translations globally for ${count} user(s).`);
            } catch (e) {
                logger.error({ err: e, channel: channelName }, 'Error disabling all translations.');
                enqueueMessage(channel, `@${invokingDisplayName}, Sorry, an error occurred trying to stop all translations.`);
            }
            return; // Action complete
        }

        // Determine the user whose translation state is being modified
        let effectiveUsernameLower = invokingUsernameLower; // Default to self
        if (targetUsername && targetUsername !== 'all') {
            // Trying to modify another user's state
            if (!isModOrBroadcaster) {
                enqueueMessage(channel, `@${invokingDisplayName}, Only mods or the broadcaster can control translation for other users.`);
                return;
            }
            effectiveUsernameLower = targetUsername; // Mod is targeting someone else
            logger.info(`[${channelName}] Mod ${invokingUsernameLower} targeting translation for ${effectiveUsernameLower}`);
        }
        const effectiveDisplayName = (effectiveUsernameLower === invokingUsernameLower) ? invokingDisplayName : targetUsername; // Use target username for display if different

        // --- Execute Action ---

        if (isStopAction) {
            // Disable translation for effectiveUsernameLower
            try {
                const wasTranslating = contextManager.disableUserTranslation(channelName, effectiveUsernameLower);
                const stopMessage = wasTranslating
                    ? `@${invokingDisplayName}, Okay, stopped translating messages for ${effectiveDisplayName}.`
                    : `@${invokingDisplayName}, Translation was already off for ${effectiveDisplayName}.`;
                enqueueMessage(channel, stopMessage);
            } catch (e) {
                logger.error({ err: e, user: effectiveUsernameLower }, 'Error disabling translation.');
                enqueueMessage(channel, `@${invokingDisplayName}, Sorry, there was an error trying to stop translation for ${effectiveDisplayName}.`);
            }
        } else {
            // Enable translation for effectiveUsernameLower
            const targetLanguage = args.slice(0, targetUsername ? 1 : undefined).join(' '); // Language is first arg if no user specified, else still first arg
            if (!targetLanguage) {
                enqueueMessage(channel, `@${invokingDisplayName}, Please specify a language.`);
                return;
            }
            try {
                contextManager.enableUserTranslation(channelName, effectiveUsernameLower, targetLanguage);

                const baseConfirmation = `Okay, translating messages for ${effectiveDisplayName} into ${targetLanguage}. Use "!translate stop${targetUsername ? ' ' + targetUsername : ''}" to disable.`;
                const translatedConfirmation = await translateText(baseConfirmation, targetLanguage);
                let finalConfirmation = `@${invokingDisplayName}, ${baseConfirmation}`;
                if (translatedConfirmation?.trim()) {
                    finalConfirmation += ` / ${translatedConfirmation}`;
                } else {
                    logger.warn(`Could not translate confirmation message into ${targetLanguage}.`);
                }
                enqueueMessage(channel, finalConfirmation);
            } catch (e) {
                logger.error({ err: e, user: effectiveUsernameLower, language: targetLanguage }, 'Error enabling translation.');
                enqueueMessage(channel, `@${invokingDisplayName}, Sorry, there was an error trying to enable translation to ${targetLanguage} for ${effectiveDisplayName}.`);
            }
        }
    },
};

export default translateHandler;