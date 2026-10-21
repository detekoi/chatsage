// tests/unit/components/commands/handlers/so.test.js

jest.mock('../../../../../src/lib/logger.js');
jest.mock('../../../../../src/lib/ircSender.js');
jest.mock('../../../../../src/components/context/contextManager.js');
jest.mock('../../../../../src/components/twitch/helixClient.js', () => ({
    getUsersByLogin: jest.fn(),
    getChannelInformation: jest.fn(),
    getLiveStreams: jest.fn(),
}));
jest.mock('../../../../../src/components/twitch/chatClient.js', () => ({
    sendShoutout: jest.fn(),
}));

import soHandler from '../../../../../src/components/commands/handlers/so.js';
import { enqueueMessage } from '../../../../../src/lib/ircSender.js';
import { getContextManager } from '../../../../../src/components/context/contextManager.js';
import { getUsersByLogin, getChannelInformation, getLiveStreams } from '../../../../../src/components/twitch/helixClient.js';
import { sendShoutout } from '../../../../../src/components/twitch/chatClient.js';

const TARGET = { id: '2000', login: 'idzuna', display_name: 'Idzuna' };

describe('So Command Handler', () => {
    const logger = { info: jest.fn(), error: jest.fn() };
    const createMockContext = (args = ['idzuna']) => ({
        channel: '#testchannel',
        user: { username: 'moduser', 'display-name': 'ModUser', id: 'msg1' },
        args,
        message: `!so ${args.join(' ')}`,
        logger,
    });

    beforeEach(() => {
        jest.clearAllMocks();
        enqueueMessage.mockResolvedValue();
        getContextManager.mockReturnValue({ getBotLanguage: () => null });
        getUsersByLogin.mockResolvedValue([TARGET]);
        getLiveStreams.mockResolvedValue([]);
        getChannelInformation.mockResolvedValue([{ broadcaster_id: TARGET.id, game_name: 'Hollow Knight' }]);
        sendShoutout.mockResolvedValue({ success: true });
    });

    test('is moderator-only and yields to a custom !so', () => {
        expect(soHandler.permission).toBe('moderator');
        expect(soHandler.yieldsToCustomCommand).toBe(true);
    });

    test('names the last game played and sends the native shoutout', async () => {
        await soHandler.execute(createMockContext());

        expect(enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            'Go check out Idzuna! They were last playing Hollow Knight: https://twitch.tv/idzuna'
        );
        expect(sendShoutout).toHaveBeenCalledWith('testchannel', TARGET.id);
    });

    test('says when the target is live right now', async () => {
        getLiveStreams.mockResolvedValue([{ user_id: TARGET.id, game_name: 'Celeste' }]);

        await soHandler.execute(createMockContext());

        expect(enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            "Go show Idzuna some love! They're live right now playing Celeste: https://twitch.tv/idzuna"
        );
    });

    test('leaves the game out when the channel never set one', async () => {
        getChannelInformation.mockResolvedValue([{ broadcaster_id: TARGET.id, game_name: '' }]);

        await soHandler.execute(createMockContext());

        expect(enqueueMessage).toHaveBeenCalledWith('#testchannel', 'Go check out Idzuna: https://twitch.tv/idzuna');
    });

    test('accepts an @mention', async () => {
        await soHandler.execute(createMockContext(['@Idzuna']));

        expect(getUsersByLogin).toHaveBeenCalledWith(['idzuna']);
    });

    test('still posts the message when Twitch refuses the native shoutout', async () => {
        sendShoutout.mockResolvedValue({ success: false, status: 429 });

        await soHandler.execute(createMockContext());

        expect(enqueueMessage).toHaveBeenCalledTimes(1);
        expect(enqueueMessage.mock.calls[0][1]).toContain('Hollow Knight');
    });

    test('shows usage without a username', async () => {
        await soHandler.execute(createMockContext([]));

        expect(enqueueMessage).toHaveBeenCalledWith('#testchannel', 'Usage: !so <username>');
        expect(sendShoutout).not.toHaveBeenCalled();
    });

    test('reports an unknown user', async () => {
        getUsersByLogin.mockResolvedValue([]);

        await soHandler.execute(createMockContext(['nobody']));

        expect(enqueueMessage).toHaveBeenCalledWith('#testchannel', 'User "nobody" not found.');
        expect(sendShoutout).not.toHaveBeenCalled();
    });

    test('refuses to shout out the channel itself without a lookup', async () => {
        await soHandler.execute(createMockContext(['@TestChannel']));

        expect(enqueueMessage).toHaveBeenCalledWith('#testchannel', "You can't shout out the channel you're in!");
        expect(getUsersByLogin).not.toHaveBeenCalled();
        expect(sendShoutout).not.toHaveBeenCalled();
    });

    test('ignores punctuation after the username', async () => {
        await soHandler.execute(createMockContext(['@idzuna,']));

        expect(getUsersByLogin).toHaveBeenCalledWith(['idzuna']);
        expect(sendShoutout).toHaveBeenCalledWith('testchannel', TARGET.id);
    });

    test('reports a name that cannot be a Twitch login without a lookup', async () => {
        await soHandler.execute(createMockContext(['not-a-login']));

        expect(enqueueMessage).toHaveBeenCalledWith('#testchannel', 'User "not-a-login" not found.');
        expect(getUsersByLogin).not.toHaveBeenCalled();
    });

    test('apologizes when a lookup throws', async () => {
        getUsersByLogin.mockRejectedValue(new Error('boom'));

        await soHandler.execute(createMockContext());

        expect(enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            'Sorry, there was an error sending the shoutout. Please try again later.'
        );
    });
});
