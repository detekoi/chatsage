// src/handlers/checkinHandler.js
// Handles Channel Points redemption events matched to the Daily Check-In reward

import logger from '../lib/logger.js';
import { enqueueMessage } from '../lib/ircSender.js';
import { getCheckinConfig, recordCheckin } from '../components/customCommands/checkinStorage.js';
import { parseVariables } from '../components/customCommands/variableParser.js';
import { resolvePrompt } from '../components/customCommands/promptResolver.js';
import { getContextManager } from '../components/context/contextManager.js';
import { buildContextPrompt } from '../components/llm/gemini/prompts.js';

/**
 * Handle a Channel Points redemption event for the Daily Check-In feature.
 * Called from eventsub.js when a channel.channel_points_custom_reward_redemption.add event fires.
 *
 * @param {object} event - The EventSub redemption event payload.
 */
export async function handleCheckinRedemption(event) {
    const channelLogin = (event?.broadcaster_user_login || event?.broadcaster_user_name)?.toLowerCase();
    const rewardId = event?.reward?.id;
    const userId = event?.user_id;
    const userName = event?.user_name || event?.user_login || 'Viewer';

    if (!channelLogin || !rewardId || !userId) {
        logger.debug({ channelLogin, rewardId, userId },
            '[CheckinHandler] Missing required fields in redemption event');
        return;
    }

    // Load the channel's check-in config
    const config = await getCheckinConfig(channelLogin);
    if (!config || !config.enabled) {
        logger.debug({ channelLogin }, '[CheckinHandler] Check-in not enabled for this channel');
        return;
    }

    // Match the reward ID
    if (config.rewardId !== rewardId) {
        logger.debug({ channelLogin, rewardId, configuredRewardId: config.rewardId },
            '[CheckinHandler] Redemption is not for the check-in reward');
        return;
    }

    // Record the check-in
    const { count, isNew } = await recordCheckin(channelLogin, userId, userName);

    logger.info({
        channel: channelLogin,
        user: userName,
        userId,
        count,
        isNew,
    }, '[CheckinHandler] Check-in recorded');

    // Build response context
    const channel = `#${channelLogin}`;
    const context = {
        user: userName,
        channel: channelLogin,
        args: [],
        useCount: count,
        checkinCount: count,
    };

    // Helper: build the static fallback message
    const buildStaticMessage = async () =>
        config.responseTemplate
            ? await parseVariables(config.responseTemplate, context)
            : `@${userName} Daily check-in #${count}! HeyGuys`;

    let responseMessage;

    if (config.useAi && config.aiPrompt) {
        // AI mode: resolve the prompt template, then feed to LLM
        const startTime = Date.now();
        try {
            const resolvedPrompt = await parseVariables(config.aiPrompt, context);

            // Gather stream context for richer AI responses
            let streamContextString = null;
            try {
                const contextManager = getContextManager();
                const llmContext = contextManager.getContextForLLM(channelLogin, userName, '');
                if (llmContext) {
                    streamContextString = buildContextPrompt(llmContext);
                }
            } catch (ctxError) {
                logger.debug({ err: ctxError, channel: channelLogin },
                    '[CheckinHandler] Could not gather stream context, proceeding without it');
            }

            const aiResponse = await resolvePrompt(resolvedPrompt, null, streamContextString);

            const elapsed = Date.now() - startTime;

            if (aiResponse) {
                responseMessage = aiResponse;
                logger.debug({ channel: channelLogin, user: userName, elapsed },
                    '[CheckinHandler] AI response received');
            } else {
                // AI returned empty — use static template
                logger.warn({ channel: channelLogin, user: userName, elapsed },
                    '[CheckinHandler] AI returned empty, using static template');
                responseMessage = await buildStaticMessage();
            }
        } catch (error) {
            logger.error({ err: error, channel: channelLogin, user: userName },
                '[CheckinHandler] AI resolution failed, using static template');
            responseMessage = await buildStaticMessage();
        }
    } else {
        // Static mode: resolve the response template
        responseMessage = await buildStaticMessage();
    }

    // Send the message
    await enqueueMessage(channel, responseMessage);
}
