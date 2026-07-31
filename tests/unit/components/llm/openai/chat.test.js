import { initializeOpenAiClient, getOpenAiInstance } from '../../../../../src/components/llm/openai/core.js';
import {
    getOrCreateChatSession,
    resetChatSession
} from '../../../../../src/components/llm/openai/chat.js';

describe('OpenAI Chat Session Module', () => {
    beforeAll(() => {
        initializeOpenAiClient({ apiKey: 'test-key', modelId: 'gpt-5.6-luna' });
    });

    beforeEach(() => {
        resetChatSession('testchannel');
        jest.clearAllMocks();
    });

    test('getOrCreateChatSession creates persistent channel session', () => {
        const s1 = getOrCreateChatSession('testchannel');
        const s2 = getOrCreateChatSession('testchannel');
        expect(s1).toBe(s2);
    });

    test('sendMessage sends message and returns Gemini-compatible wrapper', async () => {
        const instance = getOpenAiInstance();
        jest.spyOn(instance.responses, 'create').mockResolvedValueOnce({
            output_text: 'Chat bot response'
        });

        const session = getOrCreateChatSession('testchannel');
        const response = await session.sendMessage('Hello!');

        expect(response.text()).toBe('Chat bot response');
        expect(session.history.length).toBe(2); // user + assistant
    });

    test('resetChatSession removes channel session', () => {
        const s1 = getOrCreateChatSession('testchannel');
        resetChatSession('testchannel');
        const s2 = getOrCreateChatSession('testchannel');
        expect(s1).not.toBe(s2);
    });
});
