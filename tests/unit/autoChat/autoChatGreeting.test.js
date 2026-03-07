import { _getRuntime, notifyStreamOnline, maybeSendGreeting } from '../../../src/components/autoChat/autoChatManager.js';
import { getContextManager } from '../../../src/components/context/contextManager.js';
import { getChannelAutoChatConfig } from '../../../src/components/context/autoChatStorage.js';
import { enqueueMessage } from '../../../src/lib/ircSender.js';
import { buildContextPrompt, generateStandardResponse, generateSearchResponse } from '../../../src/components/llm/geminiClient.js';

// Mock all dependencies
jest.mock('../../../src/lib/logger.js');
jest.mock('../../../src/lib/ircSender.js');
jest.mock('../../../src/components/context/contextManager.js');
jest.mock('../../../src/components/llm/geminiClient.js');
jest.mock('../../../src/components/context/autoChatStorage.js');
jest.mock('../../../src/components/llm/llmUtils.js', () => ({
    removeMarkdownAsterisks: jest.fn(t => t),
}));
jest.mock('../../../src/components/twitch/streamImageCapture.js');
jest.mock('../../../src/components/llm/geminiImageClient.js');

describe('AutoChat Greeting - Stream Age Guard', () => {
    const CHANNEL = 'testchannel';

    let mockContextManager;

    beforeEach(() => {
        jest.clearAllMocks();

        // Clear runtime state
        _getRuntime().clear();

        mockContextManager = {
            getContextForLLM: jest.fn(),
        };
        getContextManager.mockReturnValue(mockContextManager);

        getChannelAutoChatConfig.mockResolvedValue({
            mode: 'high',
            categories: { greetings: true },
        });

        enqueueMessage.mockResolvedValue();
        buildContextPrompt.mockReturnValue('context prompt');
        generateStandardResponse.mockResolvedValue('Welcome to the stream!');
        generateSearchResponse.mockResolvedValue(null);
    });

    test('should skip greeting when stream has been live > 5 min (cold start scenario)', async () => {
        // Simulate bot restart mid-stream: greetedOnStart is false but stream started 30 min ago
        notifyStreamOnline(CHANNEL);

        const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        mockContextManager.getContextForLLM.mockReturnValue({
            channelName: CHANNEL,
            streamGame: 'Planet Zoo',
            streamStartedAt: thirtyMinAgo,
        });

        await maybeSendGreeting(CHANNEL);

        // Greeting should NOT have been sent
        expect(enqueueMessage).not.toHaveBeenCalled();
        expect(generateStandardResponse).not.toHaveBeenCalled();

        // greetedOnStart should be marked true so it doesn't keep re-checking
        const state = _getRuntime().get(CHANNEL);
        expect(state.greetedOnStart).toBe(true);
    });

    test('should send greeting when stream age is within 5-minute window', async () => {
        notifyStreamOnline(CHANNEL);

        const oneMinAgo = new Date(Date.now() - 1 * 60 * 1000).toISOString();
        mockContextManager.getContextForLLM.mockReturnValue({
            channelName: CHANNEL,
            streamGame: 'Planet Zoo',
            streamStartedAt: oneMinAgo,
        });

        await maybeSendGreeting(CHANNEL);

        // Greeting SHOULD have been sent
        expect(enqueueMessage).toHaveBeenCalledWith(`#${CHANNEL}`, 'Welcome to the stream!');
        const state = _getRuntime().get(CHANNEL);
        expect(state.greetedOnStart).toBe(true);
    });

    test('should not send duplicate greetings on subsequent calls', async () => {
        notifyStreamOnline(CHANNEL);

        const oneMinAgo = new Date(Date.now() - 1 * 60 * 1000).toISOString();
        mockContextManager.getContextForLLM.mockReturnValue({
            channelName: CHANNEL,
            streamGame: 'Planet Zoo',
            streamStartedAt: oneMinAgo,
        });

        // First call — greeting sent
        await maybeSendGreeting(CHANNEL);
        expect(enqueueMessage).toHaveBeenCalledTimes(1);

        // Second call — greeting should NOT be sent again (greetedOnStart is now true)
        await maybeSendGreeting(CHANNEL);
        expect(enqueueMessage).toHaveBeenCalledTimes(1);
    });

    test('should skip greeting when greetings category is disabled', async () => {
        getChannelAutoChatConfig.mockResolvedValue({
            mode: 'high',
            categories: { greetings: false },
        });

        notifyStreamOnline(CHANNEL);

        const oneMinAgo = new Date(Date.now() - 1 * 60 * 1000).toISOString();
        mockContextManager.getContextForLLM.mockReturnValue({
            channelName: CHANNEL,
            streamGame: 'Planet Zoo',
            streamStartedAt: oneMinAgo,
        });

        await maybeSendGreeting(CHANNEL);

        expect(enqueueMessage).not.toHaveBeenCalled();
    });

    test('should skip greeting when auto-chat mode is off', async () => {
        getChannelAutoChatConfig.mockResolvedValue({
            mode: 'off',
            categories: { greetings: true },
        });

        notifyStreamOnline(CHANNEL);

        await maybeSendGreeting(CHANNEL);

        expect(enqueueMessage).not.toHaveBeenCalled();
    });

    test('should send greeting when streamStartedAt is null (backwards compat)', async () => {
        // If streamStartedAt is not populated, the guard should NOT block the greeting
        notifyStreamOnline(CHANNEL);

        mockContextManager.getContextForLLM.mockReturnValue({
            channelName: CHANNEL,
            streamGame: 'Planet Zoo',
            streamStartedAt: null,
        });

        await maybeSendGreeting(CHANNEL);

        // Greeting should still be sent (no startedAt data, fallback to old behavior)
        expect(enqueueMessage).toHaveBeenCalledWith(`#${CHANNEL}`, 'Welcome to the stream!');
    });
});
