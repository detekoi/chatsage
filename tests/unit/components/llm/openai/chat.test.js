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

    test('sendMessage unwraps Gemini-style {message: parts} envelope with emote images', async () => {
        const instance = getOpenAiInstance();
        const createSpy = jest.spyOn(instance.responses, 'create').mockResolvedValueOnce({
            output_text: 'Nice emote!'
        });

        const session = getOrCreateChatSession('testchannel');
        const messageParts = [
            { text: 'USER: alice says: check this out' },
            { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }
        ];
        const response = await session.sendMessage({ message: messageParts });

        expect(response.text()).toBe('Nice emote!');
        const sentInput = createSpy.mock.calls[0][0].input;
        const userTurn = sentInput[sentInput.length - 1];
        expect(userTurn.role).toBe('user');
        expect(userTurn.content).toEqual([
            { type: 'input_text', text: 'USER: alice says: check this out' },
            { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }
        ]);
    });

    test('resetChatSession removes channel session', () => {
        const s1 = getOrCreateChatSession('testchannel');
        resetChatSession('testchannel');
        const s2 = getOrCreateChatSession('testchannel');
        expect(s1).not.toBe(s2);
    });
});
