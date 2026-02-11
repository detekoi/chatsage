// src/components/commands/handlers/followage.js
import { getChannelFollower, getUsersByLogin } from '../../twitch/helixClient.js';
import { getBroadcasterAccessToken } from '../../twitch/broadcasterTokenHelper.js';
import { getContextManager } from '../../context/contextManager.js';
import { formatFollowAge } from '../../customCommands/variableParser.js';
import config from '../../../config/index.js';

/**
 * Handler for the !followage command.
 * Shows how long a user has been following the channel.
 * 
 * Usage: !followage            → Check your own follow age
 *        !followage <username> → Check another user's follow age
 */
async function execute(context) {
    const { channel, user, args, ircClient, logger } = context;
    const channelName = channel.substring(1); // Remove '#'
    const displayName = user['display-name'] || user.username;

    // Determine which user to check
    let targetUsername = user.username;
    let targetDisplayName = displayName;
    if (args.length > 0) {
        targetUsername = args[0].toLowerCase().replace(/^@/, '');
        targetDisplayName = targetUsername;
    }

    try {
        // Get the broadcaster's access token
        const broadcasterToken = await getBroadcasterAccessToken(channelName);
        if (!broadcasterToken) {
            await ircClient.say(channel,
                `Sorry, followage data is currently unavailable. The broadcaster may need to re-authenticate.`);
            return;
        }

        // Get the broadcaster's user ID
        const contextManager = getContextManager();
        const broadcasterId = await contextManager.getBroadcasterId(channelName);
        if (!broadcasterId) {
            await ircClient.say(channel, `Sorry, couldn't determine the broadcaster ID.`);
            return;
        }

        // Get the target user's user ID
        const users = await getUsersByLogin([targetUsername]);
        if (!users || users.length === 0) {
            await ircClient.say(channel, `User "${targetUsername}" not found.`);
            return;
        }
        const targetUserId = users[0].id;
        targetDisplayName = users[0].display_name || targetUsername;

        // Check follow status
        const followData = await getChannelFollower(
            broadcasterId,
            targetUserId,
            broadcasterToken.accessToken,
            config.twitch.clientId,
        );

        if (followData) {
            const duration = formatFollowAge(followData.followed_at);
            if (targetUsername === user.username) {
                await ircClient.say(channel,
                    `${displayName}, you have been following ${channelName} for ${duration}!`);
            } else {
                await ircClient.say(channel,
                    `${targetDisplayName} has been following ${channelName} for ${duration}!`);
            }
        } else {
            if (targetUsername === user.username) {
                await ircClient.say(channel,
                    `${displayName}, you are not following ${channelName}.`);
            } else {
                await ircClient.say(channel,
                    `${targetDisplayName} is not following ${channelName}.`);
            }
        }
    } catch (error) {
        logger.error({
            err: error,
            channel: channelName,
            user: targetUsername,
        }, '[FollowageCommand] Error checking followage');
        await ircClient.say(channel,
            `Sorry, there was an error checking followage. Please try again later.`);
    }
}

export default {
    execute,
    permission: 'everyone',
    description: 'Check how long you or another user has been following the channel',
};
