import { notifyGiftSubs } from '../../../src/components/autoChat/autoChatManager.js';
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

describe('AutoChat Gift Sub Celebration', () => {
    const CHANNEL = 'testchannel';

    let mockContextManager;

    beforeEach(() => {
        jest.clearAllMocks();

        mockContextManager = {
            getContextForLLM: jest.fn(),
        };
        getContextManager.mockReturnValue(mockContextManager);

        getChannelAutoChatConfig.mockResolvedValue({
            mode: 'high',
            categories: { subscriptions: true },
        });

        enqueueMessage.mockResolvedValue();
        buildContextPrompt.mockReturnValue('context prompt');
        generateStandardResponse.mockResolvedValue('Thanks for the subs!');
        generateSearchResponse.mockResolvedValue(null);
    });

    test('should generate and send celebration for anonymous gift subs', async () => {
        mockContextManager.getContextForLLM.mockReturnValue({
            channelName: CHANNEL,
            streamGame: 'Minecraft',
        });

        await notifyGiftSubs(CHANNEL, 5, null, null);

        expect(getChannelAutoChatConfig).toHaveBeenCalledWith(CHANNEL);
        expect(mockContextManager.getContextForLLM).toHaveBeenCalledWith(CHANNEL, 'system', 'event-subscription');
        expect(buildContextPrompt).toHaveBeenCalled();
        
        // Assert prompt contents
        expect(generateStandardResponse).toHaveBeenCalledWith(
            'context prompt',
            expect.stringContaining('An anonymous gifter just gifted 5 subs to the channel!')
        );
        expect(generateStandardResponse).toHaveBeenCalledWith(
            'context prompt',
            expect.stringContaining('Do NOT list individual recipients.')
        );
        expect(enqueueMessage).toHaveBeenCalledWith(`#${CHANNEL}`, 'Thanks for the subs!');
    });

    test('should generate and send celebration for named gifter with cumulative total', async () => {
        mockContextManager.getContextForLLM.mockReturnValue({
            channelName: CHANNEL,
            streamGame: 'Minecraft',
        });

        await notifyGiftSubs(CHANNEL, 10, 'GifterGuy', 42);

        expect(generateStandardResponse).toHaveBeenCalledWith(
            'context prompt',
            expect.stringContaining("GifterGuy just gifted 10 subs to the channel! They've gifted 42 total in this channel.")
        );
        expect(enqueueMessage).toHaveBeenCalledWith(`#${CHANNEL}`, 'Thanks for the subs!');
    });

    test('should skip celebration when subscription celebrations are disabled', async () => {
        getChannelAutoChatConfig.mockResolvedValue({
            mode: 'high',
            categories: { subscriptions: false },
        });

        await notifyGiftSubs(CHANNEL, 5, 'GifterGuy', null);

        expect(enqueueMessage).not.toHaveBeenCalled();
        expect(generateStandardResponse).not.toHaveBeenCalled();
    });
});
