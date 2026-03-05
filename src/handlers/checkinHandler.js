// src/handlers/checkinHandler.js
// Handles Channel Points redemption events matched to the Daily Check-In reward

import logger from '../lib/logger.js';
import { enqueueMessage } from '../lib/ircSender.js';
import { getCheckinConfig, recordCheckin } from '../components/customCommands/checkinStorage.js';
import { parseVariables } from '../components/customCommands/variableParser.js';
import { resolvePrompt } from '../components/customCommands/promptResolver.js';

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

    let responseMessage;

    if (config.useAi && config.aiPrompt) {
        // AI mode: resolve the prompt template, then feed to LLM
        try {
            const resolvedPrompt = await parseVariables(config.aiPrompt, context);
            const aiResponse = await resolvePrompt(resolvedPrompt, channelLogin, userName);

            if (aiResponse) {
                responseMessage = aiResponse;
            } else {
                // AI fallback: use the static template
                responseMessage = config.responseTemplate
                    ? await parseVariables(config.responseTemplate, context)
                    : `@${userName} Daily check-in #${count}! 🎉`;
            }
        } catch (error) {
            logger.error({ err: error, channel: channelLogin, user: userName },
                '[CheckinHandler] AI resolution failed, using static template');
            responseMessage = config.responseTemplate
                ? await parseVariables(config.responseTemplate, context)
                : `@${userName} Daily check-in #${count}! 🎉`;
        }
    } else {
        // Static mode: resolve the response template
        responseMessage = config.responseTemplate
            ? await parseVariables(config.responseTemplate, context)
            : `@${userName} Daily check-in #${count}! 🎉`;
    }

    // Send the message
    await enqueueMessage(channel, responseMessage);
}
