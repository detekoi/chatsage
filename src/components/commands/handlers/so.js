// src/components/commands/handlers/so.js
import { getUsersByLogin, getChannelInformation, getLiveStreams } from '../../twitch/helixClient.js';
import { sendShoutout } from '../../twitch/chatClient.js';
import { getContextManager } from '../../context/contextManager.js';
import { sendLocalized } from '../../../lib/localizedMessage.js';

/**
 * Handler for the !so (shoutout) command.
 * Posts a shoutout naming what the streamer is playing now, or played last,
 * and sends Twitch's native /shoutout alongside it. The chat message goes out
 * even when Twitch refuses the native one (channel offline, cooldown, missing
 * scope), so a shoutout never silently does nothing.
 *
 * Usage: !so <username>
 */
async function execute(context) {
    const { channel, user, args, logger } = context;
    const channelName = channel.substring(1); // Remove '#'

    const targetUsername = (args[0] || '').toLowerCase().replace(/^@/, '');
    if (!targetUsername) {
        await sendLocalized(channel, 'cmd.so.Usage', {}, 'Usage: !so <username>');
        return;
    }

    try {
        const users = await getUsersByLogin([targetUsername]);
        if (!users || users.length === 0) {
            await sendLocalized(channel, 'cmd.so.UserNotFound', { targetUsername }, `User "${targetUsername}" not found.`);
            return;
        }
        const target = users[0];
        const targetDisplayName = target.display_name || target.login;
        const url = `https://twitch.tv/${target.login}`;

        const broadcasterId = await getContextManager().getBroadcasterId(channelName);
        if (broadcasterId && target.id === broadcasterId) {
            await sendLocalized(channel, 'cmd.so.OwnChannel', {}, `You can't shout out the channel you're in!`);
            return;
        }

        const [streams, channelInfo] = await Promise.all([
            getLiveStreams([target.id]),
            getChannelInformation([target.id]),
        ]);
        const liveGame = streams[0]?.game_name;
        const lastGame = channelInfo[0]?.game_name;

        // The native Shoutout runs alongside the message; its outcome is only logged
        const nativeShoutout = sendShoutout(channelName, target.id);

        if (streams.length > 0 && liveGame) {
            await sendLocalized(channel, 'cmd.so.LiveNow', { targetDisplayName, game: liveGame, url }, `Go show ${targetDisplayName} some love! They're live right now playing ${liveGame}: ${url}`);
        } else if (lastGame) {
            await sendLocalized(channel, 'cmd.so.LastPlaying', { targetDisplayName, game: lastGame, url }, `Go check out ${targetDisplayName}! They were last playing ${lastGame}: ${url}`);
        } else {
            await sendLocalized(channel, 'cmd.so.NoGame', { targetDisplayName, url }, `Go check out ${targetDisplayName}: ${url}`);
        }

        const result = await nativeShoutout;
        logger.info({
            channel: channelName,
            user: user.username,
            target: target.login,
            nativeShoutout: result.success,
            status: result.status,
        }, '[SoCommand] Shoutout sent');
    } catch (error) {
        logger.error({
            err: error,
            channel: channelName,
            target: targetUsername,
        }, '[SoCommand] Error sending shoutout');
        await sendLocalized(channel, 'cmd.so.SorryThereWasError', {}, `Sorry, there was an error sending the shoutout. Please try again later.`);
    }
}

export default {
    name: 'so',
    execute,
    permission: 'moderator',
    description: 'Shout out another streamer with what they are playing, and send Twitch\'s /shoutout',
    usage: '!so <username>',
    // A channel that already made its own !so custom command keeps it
    yieldsToCustomCommand: true,
};
