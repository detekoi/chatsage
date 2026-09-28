// tests/unit/components/twitch/chatClient.test.js

jest.mock('../../../../src/lib/logger.js');
jest.mock('../../../../src/config/index.js', () => ({
    __esModule: true,
    default: { twitch: { username: 'wildcatsage' } },
}));
jest.mock('../../../../src/components/twitch/helixClient.js', () => ({
    getUsersByLogin: jest.fn(),
    sendAnnouncement: jest.fn(),
    sendChatMessage: jest.fn(),
}));
jest.mock('../../../../src/components/twitch/broadcasterTokenHelper.js', () => ({
    getBroadcasterAccessToken: jest.fn(),
    clearCachedBroadcasterToken: jest.fn(),
    clearAllCachedBroadcasterTokens: jest.fn(),
}));
jest.mock('../../../../src/components/twitch/botTokenHelper.js', () => ({
    getBotAccessToken: jest.fn(),
    clearCachedBotToken: jest.fn(),
    _resetBotTokenState: jest.fn(),
}));

import { sendMessage, sendAnnouncement, _resetCache } from '../../../../src/components/twitch/chatClient.js';
import { getUsersByLogin, sendAnnouncement as helixSendAnnouncement, sendChatMessage as helixSendChatMessage } from '../../../../src/components/twitch/helixClient.js';
import { getBroadcasterAccessToken, clearCachedBroadcasterToken } from '../../../../src/components/twitch/broadcasterTokenHelper.js';
import { getBotAccessToken, clearCachedBotToken } from '../../../../src/components/twitch/botTokenHelper.js';

const BOT_ID = '1301215347';
const BROADCASTER_ID = '1046117957';

describe('chatClient.sendAnnouncement', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        _resetCache();
        getUsersByLogin.mockImplementation(async ([login]) => [
            { id: login === 'wildcatsage' ? BOT_ID : BROADCASTER_ID },
        ]);
        getBotAccessToken.mockResolvedValue('bot-token');
        getBroadcasterAccessToken.mockResolvedValue({ accessToken: 'broadcaster-token', twitchUserId: BROADCASTER_ID });
        helixSendAnnouncement.mockResolvedValue({ success: true });
    });

    test('sends as the bot when the bot token works', async () => {
        await expect(sendAnnouncement('#zeebthewerebear', 'hi', 'blue')).resolves.toBe(true);

        expect(helixSendAnnouncement).toHaveBeenCalledTimes(1);
        expect(helixSendAnnouncement).toHaveBeenCalledWith(BROADCASTER_ID, BOT_ID, 'hi', 'bot-token', 'blue');
        expect(getBroadcasterAccessToken).not.toHaveBeenCalled();
    });

    test('falls back to the broadcaster when the bot is not a moderator', async () => {
        helixSendAnnouncement.mockResolvedValueOnce({ success: false, status: 403 });

        await expect(sendAnnouncement('#zeebthewerebear', 'hi')).resolves.toBe(true);

        expect(helixSendAnnouncement).toHaveBeenLastCalledWith(BROADCASTER_ID, BROADCASTER_ID, 'hi', 'broadcaster-token', 'primary');
        expect(clearCachedBotToken).not.toHaveBeenCalled();
    });

    test('evicts the bot token on 401 before falling back', async () => {
        helixSendAnnouncement.mockResolvedValueOnce({ success: false, status: 401 });

        await sendAnnouncement('#zeebthewerebear', 'hi');

        expect(clearCachedBotToken).toHaveBeenCalled();
        expect(helixSendAnnouncement).toHaveBeenCalledTimes(2);
    });

    test('uses the broadcaster token when no bot token is available', async () => {
        getBotAccessToken.mockResolvedValue(null);

        await expect(sendAnnouncement('#zeebthewerebear', 'hi')).resolves.toBe(true);

        expect(helixSendAnnouncement).toHaveBeenCalledTimes(1);
        expect(helixSendAnnouncement).toHaveBeenCalledWith(BROADCASTER_ID, BROADCASTER_ID, 'hi', 'broadcaster-token', 'primary');
    });

    test('returns false when neither token can send', async () => {
        helixSendAnnouncement.mockResolvedValue({ success: false, status: 403 });

        await expect(sendAnnouncement('#zeebthewerebear', 'hi')).resolves.toBe(false);

        expect(clearCachedBroadcasterToken).toHaveBeenCalledWith('zeebthewerebear');
    });

    test('returns false when no token is available at all', async () => {
        getBotAccessToken.mockResolvedValue(null);
        getBroadcasterAccessToken.mockResolvedValue(null);

        await expect(sendAnnouncement('#zeebthewerebear', 'hi')).resolves.toBe(false);
        expect(helixSendAnnouncement).not.toHaveBeenCalled();
    });
});

describe('chatClient.sendMessage', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        _resetCache();
        getUsersByLogin.mockImplementation(async ([login]) => [
            { id: login === 'wildcatsage' ? BOT_ID : BROADCASTER_ID },
        ]);
        helixSendChatMessage.mockResolvedValue({ message_id: 'm1', is_sent: true });
    });

    test('sends through helixClient as the bot, with the reply ID', async () => {
        await expect(sendMessage('#zeebthewerebear', 'hi', { replyToId: 'parent1' })).resolves.toBe(true);

        expect(helixSendChatMessage).toHaveBeenCalledWith(BROADCASTER_ID, BOT_ID, 'hi', 'parent1');
    });

    test('caches the broadcaster ID across messages', async () => {
        await sendMessage('#zeebthewerebear', 'one');
        await sendMessage('#zeebthewerebear', 'two');

        const broadcasterLookups = getUsersByLogin.mock.calls.filter(([logins]) => logins[0] === 'zeebthewerebear');
        expect(broadcasterLookups).toHaveLength(1);
        expect(helixSendChatMessage).toHaveBeenCalledTimes(2);
    });

    test('returns false when Twitch drops the message', async () => {
        helixSendChatMessage.mockResolvedValue({ is_sent: false, drop_reason: { code: 'msg_duplicate' } });

        await expect(sendMessage('#zeebthewerebear', 'hi')).resolves.toBe(false);
    });

    test.each([undefined, {}])('returns false when Twitch does not confirm the send (%p)', async (response) => {
        helixSendChatMessage.mockResolvedValue(response);

        await expect(sendMessage('#zeebthewerebear', 'hi')).resolves.toBe(false);
    });

    test('returns false when the channel cannot be resolved', async () => {
        getUsersByLogin.mockResolvedValue([]);

        await expect(sendMessage('#nobody', 'hi')).resolves.toBe(false);
        expect(helixSendChatMessage).not.toHaveBeenCalled();
    });

    test('returns false when the Helix call throws', async () => {
        helixSendChatMessage.mockRejectedValue(new Error('boom'));

        await expect(sendMessage('#zeebthewerebear', 'hi')).resolves.toBe(false);
    });
});
