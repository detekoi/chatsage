// tests/unit/customCommands/promptResolver.test.js
import { resolvePrompt } from '../../../src/components/customCommands/promptResolver.js';
import { getGeminiClient } from '../../../src/components/llm/geminiClient.js';
import { smartTruncate } from '../../../src/components/llm/llmUtils.js';

jest.mock('../../../src/components/llm/geminiClient.js', () => ({
    getGeminiClient: jest.fn()
}));

jest.mock('../../../src/components/llm/llmUtils.js', () => ({
    smartTruncate: jest.fn((text, max) => text.substring(0, max))
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
        getGeminiClient.mockReturnValue({
            generateContent: mockGenerateContent
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

        // Should remove ** and _
        expect(result).toBe('This is a   test   response!');
    });

    test('returns fallback message if LLM returns empty', async () => {
        mockGenerateContent.mockResolvedValue({
            candidates: [{
                content: { parts: [] }
            }]
        });

        const result = await resolvePrompt('Say something fun');
        expect(result).toBe("Sorry, I couldn't think of a good response right now.");
    });

    test('returns fallback message on error', async () => {
        mockGenerateContent.mockRejectedValue(new Error('API Error'));

        const result = await resolvePrompt('Say something fun');
        expect(result).toBe('An error occurred while generating the response for this command.');
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
});
