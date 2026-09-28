// tests/unit/components/twitch/botTokenHelper.test.js

jest.mock('axios');
jest.mock('../../../../src/lib/logger.js');
jest.mock('../../../../src/config/index.js');

import axios from 'axios';
import {
    getBotAccessToken,
    clearCachedBotToken,
    _resetBotTokenState,
} from '../../../../src/components/twitch/botTokenHelper.js';
import config from '../../../../src/config/index.js';

describe('botTokenHelper', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        _resetBotTokenState();
        config.twitch = {
            clientId: 'test-client-id',
            clientSecret: 'test-client-secret',
            botRefreshToken: 'bot-refresh-token',
        };
        axios.post = jest.fn().mockResolvedValue({
            data: { access_token: 'bot-access-token', refresh_token: 'bot-refresh-token', expires_in: 3600 },
        });
    });

    test('returns null without calling Twitch when no refresh token is configured', async () => {
        config.twitch.botRefreshToken = null;

        await expect(getBotAccessToken()).resolves.toBeNull();
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('exchanges the configured refresh token and caches the access token', async () => {
        await expect(getBotAccessToken()).resolves.toBe('bot-access-token');
        await expect(getBotAccessToken()).resolves.toBe('bot-access-token');

        expect(axios.post).toHaveBeenCalledTimes(1);
        const body = new URLSearchParams(axios.post.mock.calls[0][1]);
        expect(body.get('grant_type')).toBe('refresh_token');
        expect(body.get('refresh_token')).toBe('bot-refresh-token');
    });

    test('shares one refresh between concurrent callers', async () => {
        const [a, b] = await Promise.all([getBotAccessToken(), getBotAccessToken()]);

        expect(a).toBe('bot-access-token');
        expect(b).toBe('bot-access-token');
        expect(axios.post).toHaveBeenCalledTimes(1);
    });

    test('refreshes again after the cache is cleared', async () => {
        await getBotAccessToken();
        clearCachedBotToken();
        await getBotAccessToken();

        expect(axios.post).toHaveBeenCalledTimes(2);
    });

    test('uses a rotated refresh token on the next refresh', async () => {
        axios.post.mockResolvedValueOnce({
            data: { access_token: 'first', refresh_token: 'rotated-token', expires_in: 3600 },
        });

        await getBotAccessToken();
        clearCachedBotToken();
        await getBotAccessToken();

        const secondBody = new URLSearchParams(axios.post.mock.calls[1][1]);
        expect(secondBody.get('refresh_token')).toBe('rotated-token');
    });

    test('returns null when the refresh request fails', async () => {
        axios.post.mockRejectedValueOnce(Object.assign(new Error('bad'), { response: { status: 400, data: {} } }));

        await expect(getBotAccessToken()).resolves.toBeNull();
    });
});
