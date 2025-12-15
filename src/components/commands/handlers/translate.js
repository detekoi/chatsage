import logger from '../../../lib/logger.js';
// Need contextManager functions to update user state
import { getContextManager } from '../../context/contextManager.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { translateText, COMMON_LANGUAGES } from '../../../lib/translationUtils.js';
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
            enqueueMessage(channel, `Usage: !translate <language> [user] | !translate <user> <language> | !translate stop [user|all]`, { replyToId });
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
            // Flexible parsing: Identify Language vs Username
            // args could be ["spanish", "xenmag_yt"] OR ["@xenmag_yt", "spanish"] OR ["spanish"] (self)

            // Helper to check if string matches a known language
            const isKnownLanguage = (str) => COMMON_LANGUAGES.includes(str.toLowerCase());

            // Helper to clean username
            const cleanUser = (str) => str.toLowerCase().replace(/^@/, '');

            let potentialLang = null;
            let potentialUser = null;

            if (args.length === 1) {
                // One arg: Must be language, target is self
                potentialLang = args[0];
                potentialUser = invokingUsernameLower; // Target self
            } else if (args.length >= 2) {
                const firstArg = args[0];
                const lastArg = args[args.length - 1]; // Assume multi-word lang is possible, but usually user is one word

                const firstClean = cleanUser(firstArg);
                const lastClean = cleanUser(lastArg);

                // Heuristic 1: Explicit User Mention (@user)
                if (firstArg.startsWith('@')) {
                    potentialUser = firstClean;
                    potentialLang = args.slice(1).join(' ');
                } else if (lastArg.startsWith('@')) {
                    potentialUser = lastClean;
                    potentialLang = args.slice(0, -1).join(' ');
                }
                // Heuristic 2: Known Language Match
                else if (isKnownLanguage(firstArg)) {
                    // First arg is definitely a language -> Second is likely user
                    potentialLang = firstArg; // Assume single word lang if matched
                    // If more than 2 args, things get messy, but "english otheruser" -> lang=english, user=otheruser
                    // "traditional chinese otheruser" -> lang="traditional chinese" (not in simple list), so this check fails.
                    // But if "english" is in list:
                    // Twitch usernames don't have spaces. If first arg is lang, assume last arg is user.
                    // This creates robustness against chatty syntax like "!translate english for user"
                    potentialUser = args[args.length - 1];

                    if (isModOrBroadcaster) {
                        try {
                            const users = await getUsersByLogin([cleanUser(potentialUser)]);
                            if (!users || users.length === 0) {
                                // User not found, fallback to self (assuming all args are language)
                                potentialUser = invokingUsernameLower;
                                potentialLang = args.join(' ');
                            }
                        } catch (err) {
                            // API error, fallback to self
                            potentialUser = invokingUsernameLower;
                            potentialLang = args.join(' ');
                        }
                    }


                    // Verify if user info was found, but also check permissions immediately
                    // If not privileged and trying to target someone else, default back to self.
                    if (!isModOrBroadcaster && potentialUser !== invokingUsernameLower) {
                        potentialUser = invokingUsernameLower;
                        potentialLang = args.join(' ');
                    }
                }
                else if (isKnownLanguage(lastArg)) {
                    // Last arg is known language -> First is likely user
                    potentialLang = lastArg;
                    potentialUser = args.slice(0, -1).join(' '); // multi-word user? unlikely.

                }
                // Heuristic 3: User Verification (only if we have permission to target others)
                else if (isModOrBroadcaster) {
                    // Try to resolve first arg as user
                    // "user language"
                    try {
                        const users = await getUsersByLogin([firstClean]);
                        if (users && users.length > 0) {
                            // First arg is a valid user
                            potentialUser = firstClean;
                            potentialLang = args.slice(1).join(' ');
                        } else {
                            // First arg not user, maybe last arg is user?
                            const usersLast = await getUsersByLogin([lastClean]);
                            if (usersLast && usersLast.length > 0) {
                                potentialUser = lastClean;
                                potentialLang = args.slice(0, -1).join(' ');
                            } else {
                                // Neither looks like a valid user. 
                                // Assume all is language for SELF ?? Or error?
                                // Let's assume standard syntax: !translate language (target self)
                                // or !translate user language (if accidental)
                                // Only default to self if we can't find another user.
                                potentialUser = invokingUsernameLower;
                                potentialLang = args.join(' ');
                            }
                        }
                    } catch (err) {
                        logger.error({ err }, 'Error looking up users for translate command parsing');
                        // Fallback: assume all is language for self
                        potentialUser = invokingUsernameLower;
                        potentialLang = args.join(' ');
                    }
                } else {
                    // Not mod/broadcaster? Cannot target others.
                    // Treat all as language for self
                    potentialUser = invokingUsernameLower;
                    potentialLang = args.join(' ');
                }
            }

            // Refine Parsing Result
            if (potentialUser) {
                targetUsernameLower = cleanUser(potentialUser);
            }
            if (potentialLang) {
                language = potentialLang;
            }

            // Permission Check again (if heuristics found a different user)
            if (targetUsernameLower !== invokingUsernameLower && !isModOrBroadcaster) {
                enqueueMessage(channel, `Only mods or the broadcaster can translate for other users.`, { replyToId });
                return;
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
                if (translatedConfirmation?.trim() && translatedConfirmation.toLowerCase() !== baseConfirmation.toLowerCase()) {
                    // Only append if different (prevent echoing if translation fails/is same)
                    finalConfirmation += ` / ${translatedConfirmation}`;
                } else {
                    logger.warn(`Could not translate confirmation message into ${language} (or it was identical).`);
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