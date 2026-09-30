// tests/unit/autoChat/autoChatGreetingClaim.test.js
// greetedOnStart lives in process memory, so when a channel changes instance
// inside the greeting window the stream-scoped Firestore claim is what keeps
// chat from being greeted twice.
import { _getRuntime, notifyStreamOnline, maybeSendGreeting } from '../../../src/components/autoChat/autoChatManager.js';
import { getContextManager } from '../../../src/components/context/contextManager.js';
import { getChannelAutoChatConfig } from '../../../src/components/context/autoChatStorage.js';
import { enqueueMessage } from '../../../src/lib/ircSender.js';
import { buildContextPrompt, generateStandardResponse } from '../../../src/components/llm/llmClient.js';
import { isOwnershipEnabled } from '../../../src/lib/channelOwnership.js';
import { isDuplicateEvent } from '../../../src/lib/distributedCache.js';

jest.mock('../../../src/lib/logger.js');
jest.mock('../../../src/lib/ircSender.js');
jest.mock('../../../src/components/context/contextManager.js');
jest.mock('../../../src/components/llm/llmClient.js');
jest.mock('../../../src/components/context/autoChatStorage.js');
jest.mock('../../../src/components/llm/llmUtils.js', () => ({ removeMarkdownAsterisks: jest.fn(t => t) }));
jest.mock('../../../src/components/twitch/streamImageCapture.js');
jest.mock('../../../src/components/llm/geminiImageClient.js');
jest.mock('../../../src/lib/channelOwnership.js', () => ({
    isOwnershipEnabled: jest.fn(() => true),
    ownsChannel: jest.fn(() => true),
}));
jest.mock('../../../src/lib/distributedCache.js', () => ({ isDuplicateEvent: jest.fn() }));

const CHANNEL = 'parfaitfair';
const STARTED_AT = new Date(Date.now() - 60 * 1000).toISOString();

describe('AutoChat greeting claim', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        _getRuntime().clear();
        getContextManager.mockReturnValue({
            getContextForLLM: jest.fn(() => ({ channelName: CHANNEL, streamGame: 'Zelda', streamStartedAt: STARTED_AT })),
        });
        getChannelAutoChatConfig.mockResolvedValue({ mode: 'high', categories: { greetings: true } });
        enqueueMessage.mockResolvedValue();
        buildContextPrompt.mockReturnValue('context prompt');
        generateStandardResponse.mockResolvedValue('Welcome back!');
        isOwnershipEnabled.mockReturnValue(true);
        notifyStreamOnline(CHANNEL);
    });

    test('greets when this stream has not been greeted', async () => {
        isDuplicateEvent.mockResolvedValue(false);

        await maybeSendGreeting(CHANNEL);

        expect(isDuplicateEvent).toHaveBeenCalledWith(`greeting:${CHANNEL}:${STARTED_AT}`, null, expect.any(Number), true);
        expect(enqueueMessage).toHaveBeenCalledWith(`#${CHANNEL}`, 'Welcome back!');
    });

    test('skips a greeting another instance already sent for this stream', async () => {
        isDuplicateEvent.mockResolvedValue(true);

        await maybeSendGreeting(CHANNEL);

        expect(generateStandardResponse).not.toHaveBeenCalled();
        expect(enqueueMessage).not.toHaveBeenCalled();
        expect(_getRuntime().get(CHANNEL).greetedOnStart).toBe(true);
    });

    test('a single process does not need the claim', async () => {
        isOwnershipEnabled.mockReturnValue(false);

        await maybeSendGreeting(CHANNEL);

        expect(isDuplicateEvent).not.toHaveBeenCalled();
        expect(enqueueMessage).toHaveBeenCalledTimes(1);
    });
});
