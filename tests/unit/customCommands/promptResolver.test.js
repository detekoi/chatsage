// tests/unit/customCommands/promptResolver.test.js
import { resolvePrompt, formatHistoryForPrompt } from '../../../src/components/customCommands/promptResolver.js';
import { getGenAIInstance } from '../../../src/components/llm/gemini/core.js';
import { smartTruncate } from '../../../src/components/llm/llmUtils.js';
import { getRecentInferences, logInference } from '../../../src/components/llm/inferenceHistoryStorage.js';

jest.mock('../../../src/components/llm/gemini/core.js', () => ({
    getGenAIInstance: jest.fn()
}));

jest.mock('../../../src/components/llm/llmUtils.js', () => ({
    smartTruncate: jest.fn((text, max) => text.substring(0, max))
}));

jest.mock('../../../src/components/llm/inferenceHistoryStorage.js', () => ({
    getRecentInferences: jest.fn().mockResolvedValue([]),
    logInference: jest.fn().mockResolvedValue(undefined),
    CHECKIN_SOURCE: 'checkin',
    customCommandSource: jest.fn((name) => `custom:${name}`),
}));

jest.mock('../../../src/lib/logger.js', () => ({
    __esModule: true,
    default: {
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
        error: jest.fn()
    }
}));

describe('promptResolver', () => {
    let mockGenerateContent;

    beforeEach(() => {
        jest.clearAllMocks();
        mockGenerateContent = jest.fn();
        getGenAIInstance.mockReturnValue({
            models: {
                generateContent: mockGenerateContent
            }
        });
    });

    test('returns empty string if prompt is empty', async () => {
        expect(await resolvePrompt(null)).toBe('');
        expect(await resolvePrompt('')).toBe('');
    });

    test('successfully generates and cleans response', async () => {
        mockGenerateContent.mockResolvedValue({
            candidates: [{
                content: {
                    parts: [{ text: '**This is** a _ test _ response!' }]
                }
            }]
        });

        const result = await resolvePrompt('Say something fun');

        expect(mockGenerateContent).toHaveBeenCalledWith(expect.objectContaining({
            contents: [{ role: 'user', parts: [{ text: 'Say something fun' }] }]
        }));

        // Should remove ** and _ (with trailing space)
        expect(result).toBe('This is a  test  response!');
    });

    test('returns null if LLM returns empty', async () => {
        mockGenerateContent.mockResolvedValue({
            candidates: [{
                content: { parts: [] }
            }]
        });

        const result = await resolvePrompt('Say something fun');
        expect(result).toBeNull();
    });

    test('returns null on error', async () => {
        mockGenerateContent.mockRejectedValue(new Error('API Error'));

        const result = await resolvePrompt('Say something fun');
        expect(result).toBeNull();
    });

    test('truncates response if too long', async () => {
        const longResponse = 'a'.repeat(500);
        mockGenerateContent.mockResolvedValue({
            candidates: [{
                content: { parts: [{ text: longResponse }] }
            }]
        });

        const result = await resolvePrompt('Say something fun');
        expect(smartTruncate).toHaveBeenCalledWith(longResponse, 450);
        expect(result).toBe('a'.repeat(450));
    });

    test('includes language directive in system instruction when language is set', async () => {
        mockGenerateContent.mockResolvedValue({
            candidates: [{
                content: { parts: [{ text: 'Hola amigo!' }] }
            }]
        });

        await resolvePrompt('Say hello', 'spanish');

        const callArgs = mockGenerateContent.mock.calls[0][0];
        expect(callArgs.config.systemInstruction.parts[0].text).toContain('You MUST respond entirely in spanish.');
    });

    test('does not include language directive when language is null', async () => {
        mockGenerateContent.mockResolvedValue({
            candidates: [{
                content: { parts: [{ text: 'Hello friend!' }] }
            }]
        });

        await resolvePrompt('Say hello');

        const callArgs = mockGenerateContent.mock.calls[0][0];
        expect(callArgs.config.systemInstruction.parts[0].text).not.toContain('You MUST respond entirely in');
    });

    // ─── Stream context ─────────────────────────────────────────────────

    describe('stream context', () => {
        test('appends stream context to prompt when provided', async () => {
            mockGenerateContent.mockResolvedValue({
                candidates: [{
                    content: { parts: [{ text: 'Contextual response!' }] }
                }]
            });

            await resolvePrompt('Check-in prompt', null, 'Channel: testchannel\nGame: Minecraft');

            const callArgs = mockGenerateContent.mock.calls[0][0];
            expect(callArgs.contents[0].parts[0].text).toContain('Check-in prompt');
            expect(callArgs.contents[0].parts[0].text).toContain('--- Stream Context ---');
            expect(callArgs.contents[0].parts[0].text).toContain('Channel: testchannel');
        });

        test('does not append context block when streamContext is null', async () => {
            mockGenerateContent.mockResolvedValue({
                candidates: [{
                    content: { parts: [{ text: 'No context response!' }] }
                }]
            });

            await resolvePrompt('Check-in prompt', null, null);

            const callArgs = mockGenerateContent.mock.calls[0][0];
            expect(callArgs.contents[0].parts[0].text).toBe('Check-in prompt');
            expect(callArgs.contents[0].parts[0].text).not.toContain('--- Stream Context ---');
        });
    });

    // ─── Chat context ───────────────────────────────────────────────────

    describe('chat context', () => {
        test('appends chat context to prompt when provided', async () => {
            mockGenerateContent.mockResolvedValue({
                candidates: [{
                    content: { parts: [{ text: 'Contextual response!' }] }
                }]
            });

            await resolvePrompt('Check-in prompt', null, null, false, {
                chatContext: 'user1: hello\nuser2: what game is this',
            });

            const callArgs = mockGenerateContent.mock.calls[0][0];
            expect(callArgs.contents[0].parts[0].text).toContain('--- Recent Chat ---');
            expect(callArgs.contents[0].parts[0].text).toContain('user1: hello');
        });

        test('does not append chat context block when chatContext is null', async () => {
            mockGenerateContent.mockResolvedValue({
                candidates: [{
                    content: { parts: [{ text: 'No context response!' }] }
                }]
            });

            await resolvePrompt('Check-in prompt', null, null, false, { chatContext: null });

            const callArgs = mockGenerateContent.mock.calls[0][0];
            expect(callArgs.contents[0].parts[0].text).not.toContain('--- Recent Chat ---');
        });
    });

    // ─── Encapsulated dedup lifecycle ───────────────────────────────────

    describe('encapsulated dedup lifecycle', () => {
        test('fetches history and injects it when channel+source are provided', async () => {
            getRecentInferences.mockResolvedValue(['prev response 1', 'prev response 2']);
            mockGenerateContent.mockResolvedValue({
                candidates: [{
                    content: { parts: [{ text: 'Unique response!' }] }
                }]
            });

            await resolvePrompt('Say something', null, null, false, {
                channel: 'testchannel',
                source: 'custom:hug',
            });

            expect(getRecentInferences).toHaveBeenCalledWith('testchannel', 'custom:hug');
            const callArgs = mockGenerateContent.mock.calls[0][0];
            expect(callArgs.contents[0].parts[0].text).toContain('"prev response 1"');
            expect(callArgs.contents[0].parts[0].text).toContain('"prev response 2"');
        });

        test('logs inference after successful generation', async () => {
            mockGenerateContent.mockResolvedValue({
                candidates: [{
                    content: { parts: [{ text: 'New response!' }] }
                }]
            });

            await resolvePrompt('Say something', null, null, false, {
                channel: 'testchannel',
                source: 'checkin',
            });

            expect(logInference).toHaveBeenCalledWith('testchannel', 'checkin', 'New response!');
        });

        test('does NOT log inference when LLM returns empty', async () => {
            mockGenerateContent.mockResolvedValue({
                candidates: [{ content: { parts: [] } }]
            });

            await resolvePrompt('Say something', null, null, false, {
                channel: 'testchannel',
                source: 'checkin',
            });

            expect(logInference).not.toHaveBeenCalled();
        });

        test('does NOT log inference when LLM throws error', async () => {
            mockGenerateContent.mockRejectedValue(new Error('API Error'));

            await resolvePrompt('Say something', null, null, false, {
                channel: 'testchannel',
                source: 'checkin',
            });

            expect(logInference).not.toHaveBeenCalled();
        });

        test('does not fetch history or log when channel/source are not provided', async () => {
            mockGenerateContent.mockResolvedValue({
                candidates: [{
                    content: { parts: [{ text: 'Normal response!' }] }
                }]
            });

            await resolvePrompt('Say something');

            expect(getRecentInferences).not.toHaveBeenCalled();
            expect(logInference).not.toHaveBeenCalled();
        });

        test('combines stream context, chat context, and history in correct order', async () => {
            getRecentInferences.mockResolvedValue(['old response']);
            mockGenerateContent.mockResolvedValue({
                candidates: [{
                    content: { parts: [{ text: 'Combined response!' }] }
                }]
            });

            await resolvePrompt('Base prompt', null, 'Channel: test\nGame: Minecraft', false, {
                channel: 'testchannel',
                source: 'custom:test',
                chatContext: 'user1: hello',
            });

            const callArgs = mockGenerateContent.mock.calls[0][0];
            const promptText = callArgs.contents[0].parts[0].text;

            // Verify ordering: base prompt → stream context → chat context → history
            const streamIdx = promptText.indexOf('--- Stream Context ---');
            const chatIdx = promptText.indexOf('--- Recent Chat ---');
            const historyIdx = promptText.indexOf('"old response"');
            expect(streamIdx).toBeGreaterThan(0);
            expect(chatIdx).toBeGreaterThan(streamIdx);
            expect(historyIdx).toBeGreaterThan(chatIdx);
        });
    });

    // ─── formatHistoryForPrompt ─────────────────────────────────────────

    describe('formatHistoryForPrompt', () => {
        test('returns null for empty array', () => {
            expect(formatHistoryForPrompt([])).toBeNull();
        });

        test('returns null for non-array input', () => {
            expect(formatHistoryForPrompt(null)).toBeNull();
            expect(formatHistoryForPrompt(undefined)).toBeNull();
        });

        test('formats responses as numbered list with dedup instruction', () => {
            const result = formatHistoryForPrompt(['Hello there!', 'Welcome back!']);
            expect(result).toContain('DO NOT repeat');
            expect(result).toContain('1. "Hello there!"');
            expect(result).toContain('2. "Welcome back!"');
        });

        test('preserves order of responses', () => {
            const result = formatHistoryForPrompt(['first', 'second', 'third']);
            const firstIndex = result.indexOf('1. "first"');
            const secondIndex = result.indexOf('2. "second"');
            const thirdIndex = result.indexOf('3. "third"');
            expect(firstIndex).toBeLessThan(secondIndex);
            expect(secondIndex).toBeLessThan(thirdIndex);
        });
    });
});
