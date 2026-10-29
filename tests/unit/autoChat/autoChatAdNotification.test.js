import { notifyAdSoon, notifyAdBreak } from '../../../src/components/autoChat/autoChatManager.js';
import { getChannelAutoChatConfig } from '../../../src/components/context/autoChatStorage.js';
import { enqueueMessage, enqueueAnnouncement } from '../../../src/lib/ircSender.js';
import { isDuplicateEvent } from '../../../src/lib/distributedCache.js';

jest.mock('../../../src/lib/logger.js');
jest.mock('../../../src/lib/ircSender.js');
jest.mock('../../../src/lib/distributedCache.js');
jest.mock('../../../src/components/context/contextManager.js');
jest.mock('../../../src/components/llm/llmClient.js');
jest.mock('../../../src/components/context/autoChatStorage.js');
jest.mock('../../../src/components/llm/llmUtils.js', () => ({
    removeMarkdownAsterisks: jest.fn(t => t),
}));
jest.mock('../../../src/components/twitch/streamImageCapture.js');
jest.mock('../../../src/components/llm/geminiImageClient.js');

describe('AutoChat ad notifications', () => {
    const CHANNEL = 'testchannel';

    beforeEach(() => {
        jest.clearAllMocks();
        getChannelAutoChatConfig.mockResolvedValue({ mode: 'off', categories: { ads: true } });
        isDuplicateEvent.mockResolvedValue(false);
        enqueueMessage.mockResolvedValue();
    });

    test('sends the ad warning as a regular chat message', async () => {
        await notifyAdSoon(CHANNEL, 60, 'Ads in a minute!', 1700000000000);

        expect(enqueueMessage).toHaveBeenCalledWith(`#${CHANNEL}`, 'Ads in a minute!');
        expect(enqueueAnnouncement).not.toHaveBeenCalled();
    });

    test('sends the ad break start as a regular chat message', async () => {
        const { getContextManager } = await import('../../../src/components/context/contextManager.js');
        const { buildContextPrompt, generateStandardResponse } = await import('../../../src/components/llm/llmClient.js');
        getContextManager.mockReturnValue({ getContextForLLM: jest.fn().mockReturnValue({ streamGame: 'Minecraft' }) });
        buildContextPrompt.mockReturnValue('context prompt');
        generateStandardResponse.mockResolvedValue('Ad break, grab a snack!');

        await notifyAdBreak(CHANNEL, { duration_seconds: 90 });

        expect(enqueueMessage).toHaveBeenCalledWith(`#${CHANNEL}`, 'Ad break, grab a snack!');
        expect(enqueueAnnouncement).not.toHaveBeenCalled();
    });

    test('sends nothing when ad notifications are off', async () => {
        getChannelAutoChatConfig.mockResolvedValue({ mode: 'high', categories: { ads: false } });

        await notifyAdSoon(CHANNEL, 60, 'Ads in a minute!');

        expect(enqueueMessage).not.toHaveBeenCalled();
    });
});
