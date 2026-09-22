import { initializeOpenAiClient, getOpenAiInstance } from '../../../../../src/components/llm/openai/core.js';
import {
    getOrCreateChatSession,
    getChatSession,
    resetChatSession
} from '../../../../../src/components/llm/openai/chat.js';

describe('OpenAI Chat Session Module', () => {
    beforeAll(() => {
        initializeOpenAiClient({ apiKey: 'test-key', modelId: 'gpt-6-luna' });
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

    test('sendMessage sends ephemeralContext with the request but keeps it out of history', async () => {
        const instance = getOpenAiInstance();
        const createSpy = jest.spyOn(instance.responses, 'create').mockResolvedValue({
            output_text: 'Oh yeah, that one.'
        });

        const session = getOrCreateChatSession('testchannel');
        const memoryBlock = '--- CHANNEL MEMORY ---\n- Gary is the duck.\n--- END CHANNEL MEMORY ---';
        await session.sendMessage({ message: [{ text: 'USER: alice says: who is gary' }], ephemeralContext: memoryBlock });

        const sentInput = createSpy.mock.calls[0][0].input;
        expect(sentInput[sentInput.length - 1].content).toEqual([
            { type: 'input_text', text: memoryBlock },
            { type: 'input_text', text: 'USER: alice says: who is gary' }
        ]);
        expect(JSON.stringify(session.history)).not.toContain('CHANNEL MEMORY');

        // The next turn must not re-send the earlier turn's memory block.
        await session.sendMessage('thanks');
        expect(JSON.stringify(createSpy.mock.calls[1][0].input)).not.toContain('CHANNEL MEMORY');
    });

    test('sendMessage prepends ephemeralContext to a plain string message', async () => {
        const instance = getOpenAiInstance();
        const createSpy = jest.spyOn(instance.responses, 'create').mockResolvedValueOnce({ output_text: 'ok' });

        const session = getOrCreateChatSession('testchannel');
        await session.sendMessage({ message: 'who is gary', ephemeralContext: 'MEMO' });

        const sentInput = createSpy.mock.calls[0][0].input;
        expect(sentInput[sentInput.length - 1].content).toBe('MEMO\n\nwho is gary');
        expect(session.history[0].content).toBe('who is gary');
    });

    test('sendMessage rolls back the user turn when the request fails', async () => {
        const instance = getOpenAiInstance();
        const createSpy = jest.spyOn(instance.responses, 'create');
        createSpy.mockResolvedValueOnce({ output_text: 'First reply' });

        const session = getOrCreateChatSession('testchannel');
        await session.sendMessage('First message');

        // Non-retryable, so retryWithBackoff fails straight away.
        createSpy.mockRejectedValueOnce(Object.assign(new Error('Invalid request'), { status: 400 }));
        await expect(session.sendMessage('Poison message')).rejects.toThrow('Invalid request');

        expect(session.history).toEqual([
            { role: 'user', content: 'First message' },
            { role: 'assistant', content: 'First reply' }
        ]);
    });

    test('getChatSession returns the cached session without creating one', () => {
        expect(getChatSession('testchannel')).toBeNull();
        const created = getOrCreateChatSession('testchannel');
        expect(getChatSession('testchannel')).toBe(created);
        expect(getChatSession('')).toBeNull();
    });

    test('recordExchange appends a user/assistant pair that the next request includes', async () => {
        const instance = getOpenAiInstance();
        const createSpy = jest.spyOn(instance.responses, 'create').mockResolvedValueOnce({
            output_text: 'Plug the cable into the service port.'
        });

        const session = getOrCreateChatSession('testchannel');
        session.recordExchange('USER: alice says: !game how do i update pokia firmware', 'For Pokia: connect it for servicing, then run the update.');
        expect(session.history).toEqual([
            { role: 'user', content: 'USER: alice says: !game how do i update pokia firmware' },
            { role: 'assistant', content: 'For Pokia: connect it for servicing, then run the update.' }
        ]);

        await session.sendMessage('USER: alice says: how do i connect it');

        const sentInput = createSpy.mock.calls[0][0].input;
        expect(sentInput.map(t => t.role)).toEqual(['user', 'assistant', 'user']);
        expect(sentInput[1].content).toBe('For Pokia: connect it for servicing, then run the update.');
    });

    test('recordExchange ignores empty turns and keeps the history window bounded', () => {
        const session = getOrCreateChatSession('testchannel');
        session.recordExchange('', 'reply');
        session.recordExchange('question', '   ');
        expect(session.history).toEqual([]);

        for (let i = 0; i < 20; i++) {
            session.recordExchange(`q${i}`, `a${i}`);
        }
        expect(session.history.length).toBe(30);
        expect(session.history[0]).toEqual({ role: 'user', content: 'q5' });
        expect(session.history[29]).toEqual({ role: 'assistant', content: 'a19' });
    });

    test('resetChatSession removes channel session', () => {
        const s1 = getOrCreateChatSession('testchannel');
        resetChatSession('testchannel');
        const s2 = getOrCreateChatSession('testchannel');
        expect(s1).not.toBe(s2);
    });
});
