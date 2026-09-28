// tests/unit/components/twitch/chatClientAnnouncement.test.js

jest.mock('../../../../src/lib/logger.js');
jest.mock('../../../../src/config/index.js', () => ({
    __esModule: true,
    default: { twitch: { username: 'wildcatsage' } },
}));
jest.mock('../../../../src/components/twitch/helixClient.js', () => ({
    getUsersByLogin: jest.fn(),
    sendAnnouncement: jest.fn(),
}));
jest.mock('../../../../src/components/twitch/auth.js', () => ({
    getAppAccessToken: jest.fn(),
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

import { sendAnnouncement, _resetCache } from '../../../../src/components/twitch/chatClient.js';
import { getUsersByLogin, sendAnnouncement as helixSendAnnouncement } from '../../../../src/components/twitch/helixClient.js';
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
