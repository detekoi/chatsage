import logger from '../../../lib/logger.js';
// Need contextManager functions to update user state
import { getContextManager } from '../../context/contextManager.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { translateText } from '../../../lib/translationUtils.js';
import { getUsersByLogin } from '../../twitch/helixClient.js';


// Helper function to check mod/broadcaster status
function isPrivilegedUser(tags, channelName) {
    const isMod = tags.mod === '1' || tags.badges?.moderator === '1';
    const isBroadcaster = tags.badges?.broadcaster === '1' || tags.username === channelName;
    return isMod || isBroadcaster;
}

/**
 * Handler for the !translate command with moderator controls and robust argument parsing.
 */
const translateHandler = {
    name: 'translate',
    description: 'Manage automatic message translation for users.',
    usage: '!translate <language> | !translate stop | !translate <language> <user> | !translate stop <user> | !translate stop all (Mods/Broadcaster)',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelName = channel.substring(1);
        const invokingUsernameLower = user.username;
        const invokingDisplayName = user['display-name'] || user.username;
        const replyToId = user?.id || user?.['message-id'] || null;
        const contextManager = getContextManager();
        const isModOrBroadcaster = isPrivilegedUser(user, channelName);

        // --- Input Validation ---
        if (args.length === 0) {
            enqueueMessage(channel, `Usage: !translate <language> | !translate stop | !translate <lang> <user> | !translate stop <user> | !translate stop all (Mods/Broadcaster)`, { replyToId });
            return;
        }

        const action = args[0].toLowerCase();
        const isStopAction = action === 'stop';

        // --- Handle !translate stop all ---
        if (isStopAction && args.length > 1 && args[1].toLowerCase() === 'all') {
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

        // --- Argument Parsing Logic ---
        let targetUsernameLower = null;
        let language = null;

        if (isStopAction) {
            // Handle !translate stop [username]
            if (args.length > 1) {
                const potentialUsername = args[1].toLowerCase().replace(/^@/, '');
                if (!isModOrBroadcaster) {
                    enqueueMessage(channel, `Only mods or the broadcaster can stop translation for other users.`, { replyToId });
                    return;
                }
                targetUsernameLower = potentialUsername;
            } else {
                targetUsernameLower = invokingUsernameLower;
            }
        } else {
            // Handle !translate <language> [username]
            if (args.length === 1) {
                // Single argument is always language, target self
                targetUsernameLower = invokingUsernameLower;
                language = args[0];
            } else { // args.length > 1
                // Check if the last argument could be a username *intended* as such
                const potentialUsername = args[args.length - 1].toLowerCase().replace(/^@/, '');
                let isTargetingOther = false; // Assume not targeting other initially

                // Only mods/broadcasters can target others explicitly
                if (isModOrBroadcaster) {
                    // Check if the last arg *is* a real user AND it's not the invoking user themselves
                    // (prevents "!translate Pig Latin" from being interpreted as targeting user 'latin')
                    try {
                        const users = await getUsersByLogin([potentialUsername]);
                        if (users && users.length > 0 && potentialUsername !== invokingUsernameLower) {
                            // It's a real user, and it's not self. Treat as targeting.
                            isTargetingOther = true;
                            targetUsernameLower = potentialUsername;
                            language = args.slice(0, -1).join(' ');
                        }
                    } catch (e) {
                        logger.error({ err: e, potentialUsername }, 'Error checking username with Twitch API');
                        // Error out for clarity when API fails
                        enqueueMessage(channel, `Error checking username. Could not process command.`, { replyToId });
                        return;
                    }
                }

                // If we didn't identify the last arg as an intended target username...
                if (!isTargetingOther) {
                    // Treat all args as language, target self
                    targetUsernameLower = invokingUsernameLower;
                    language = args.join(' ');
                }
            }
        }

        // --- Determine target display name ---
        const effectiveDisplayName = (targetUsernameLower === invokingUsernameLower) ? invokingDisplayName : targetUsernameLower;

        // --- Execute Action ---
        try {
            if (isStopAction) {
                // Disable translation
                const wasTranslating = contextManager.disableUserTranslation(channelName, targetUsernameLower);
                const stopMessage = wasTranslating
                    ? `Okay, stopped translating messages for ${effectiveDisplayName}.`
                    : `Translation was already off for ${effectiveDisplayName}.`;
                enqueueMessage(channel, stopMessage, { replyToId });
            } else {
                // Enable translation
                if (!language) {
                    enqueueMessage(channel, `Please specify a language.`, { replyToId });
                    return;
                }
                contextManager.enableUserTranslation(channelName, targetUsernameLower, language);
                const baseConfirmation = `Okay, translating messages for ${effectiveDisplayName} into ${language}. Use "!translate stop${targetUsernameLower !== invokingUsernameLower ? ' ' + targetUsernameLower : ''}" to disable.`;
                const translatedConfirmation = await translateText(baseConfirmation, language);
                let finalConfirmation = `${baseConfirmation}`;
                if (translatedConfirmation?.trim()) {
                    finalConfirmation += ` / ${translatedConfirmation}`;
                } else {
                    logger.warn(`Could not translate confirmation message into ${language}.`);
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