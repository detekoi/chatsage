// src/components/commands/handlers/lurk.js
import logger from '../../../lib/logger.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { getOrCreateChatSession, buildContextPrompt } from '../../llm/geminiClient.js';
import { removeMarkdownAsterisks } from '../../llm/llmUtils.js';
import { getContextManager } from '../../context/contextManager.js';

/**
 * Handler for the !lurk command.
 * Provides a fun, contextual send-off to a user who is going to lurk.
 */
const lurkHandler = {
    name: 'lurk',
    description: 'Let the chat know you are lurking. Provide an optional reason for a custom send-off.',
    usage: '!lurk [your reason for lurking]',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, args } = context;
        const displayName = user['display-name'] || user.username;
        const lurkReason = args.join(' ').trim();
        const channelName = channel.substring(1); // Remove '#' for context manager
        const contextManager = getContextManager();

        try {
            // Get the full context object from the context manager (proceed even if unavailable)
            const llmContext = contextManager.getContextForLLM(channelName, displayName, `is going to lurk. Reason: ${lurkReason || 'none'}`) || {};

            // Build the comprehensive chat context using the shared helper
            const chatContext = buildContextPrompt(llmContext);

            let prompt;

            if (lurkReason) {
                // Prompt that focuses on the user's reason for lurking
                prompt = `A Twitch user named "${displayName}" is about to start lurking. Their reason is: "${lurkReason}". Based on the recent chat conversation, write a brief, natural send-off that incorporates their reason. Wordplay and unexpected poetry are welcome, but avoid tired clichés like "catch you on the flip side", "see you later", or "enjoy". Be fresh. Keep it under 20 words.`;
            } else {
                // Prompt for a general lurk command, using chat context
                prompt = `A Twitch user named "${displayName}" is about to start lurking. Based on the recent chat conversation, write a brief, natural send-off. Wordplay and unexpected poetry are welcome, but avoid tired clichés like "catch you on the flip side", "see you later", or "enjoy". Be fresh. Keep it under 20 words.`;
            }

            // Use the persistent chat session and send one concise prompt including context
            const chatSession = getOrCreateChatSession(channelName);
            const fullPrompt = `${chatContext}\nTASK: ${prompt}\nCONSTRAINTS: One fresh, natural line. Wordplay welcome. No tired clichés. No usernames or @handles. ≤20 words.`;
            const result = await chatSession.sendMessage({ message: fullPrompt });
            let llmResponse = typeof result?.text === 'function' ? result.text() : (typeof result?.text === 'string' ? result.text : '');

            let response;
            if (llmResponse && llmResponse.trim()) {
                llmResponse = llmResponse.replace(/^"|"$/g, '').trim();
                // Remove markdown asterisks
                llmResponse = removeMarkdownAsterisks(llmResponse);
                response = `${llmResponse}`;
            } else {
                logger.warn({ channel: channelName }, 'LLM did not return content for !lurk; using fallback.');
                const variedFallbacks = [
                    'slipping into stealth mode—crunch, crunch, cone patrol.',
                    'vanishing act engaged; we’ll keep the stage warm.',
                    'xp farm in the shadows—report back with sprinkles.',
                    'brb in ghost chat—footsteps soft, vibes loud.',
                    'silent tab open, chaos in spirit.',
                    'cloak equipped, snack quest accepted.',
                    'lurkmobile rolling—headlights off, radar on.',
                    'soft shoes on tile—*shff shff*—stealth engaged.',
                    'threading the shadows with sprinkles in tow.',
                    'tab open, volume low, mischief high.',
                    'dusting the dojo: sweep, swipe, swoosh.',
                    'blanket fort protocol active—whisper ping when needed.',
                    'moonwalk to afk; crumbs as waypoints.',
                    'charging crystals in the background—zap when ready.',
                    'kitchen boss fight: sponge, soap, victory fanfare.',
                    'Z-catch initiated—dreams set to widescreen.'
                ];
                const alt = variedFallbacks[Math.floor(Math.random() * variedFallbacks.length)];
                response = `${alt}`;
            }

            const replyToId = user?.id || user?.['message-id'] || null;
            enqueueMessage(channel, response, { replyToId });
            logger.info(`Executed !lurk command in ${channel} for ${displayName}`);

        } catch (error) {
            logger.error({ err: error, channel: channel, user: user.username }, 'Error executing !lurk command');
            return;
        }
    },
};

export default lurkHandler;