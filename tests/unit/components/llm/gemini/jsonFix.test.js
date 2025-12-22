
// tests/unit/components/llm/gemini/jsonFix.test.js

jest.mock('../../../../../src/lib/logger.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

// Mock core.js
jest.mock('../../../../../src/components/llm/gemini/core.js', () => {
    const mockGenerateContent = jest.fn();
    return {
        getGeminiClient: jest.fn(() => ({
            generateContent: mockGenerateContent
        })),
        getGenAIInstance: jest.fn(),
        getConfiguredModelId: jest.fn(),
        // Export the mock function so we can access it in tests
        __mockGenerateContent: mockGenerateContent
    };
});


import logger from '../../../../../src/lib/logger.js';
import { generateStandardResponse } from '../../../../../src/components/llm/gemini/generation.js';
import { getGeminiClient } from '../../../../../src/components/llm/gemini/core.js';

describe('generateStandardResponse JSON Fix', () => {
    let mockGenerateContent;

    beforeEach(() => {
        jest.clearAllMocks();
        // Retrieve the shared mock function reference
        mockGenerateContent = getGeminiClient().generateContent;

        // Setup default mock response structure - plain text
        mockGenerateContent.mockResolvedValue({
            candidates: [{
                content: {
                    parts: [{ text: 'Default response' }]
                }
            }],
            text: () => 'Default response'
        });
    });

    it('should return plain text as is', async () => {
        mockGenerateContent.mockResolvedValue({
            candidates: [{
                content: {
                    parts: [{ text: 'Hello world' }]
                }
            }],
            text: () => 'Hello world'
        });

        const result = await generateStandardResponse('context', 'query');
        expect(result).toBe('Hello world');
    });

    it('should extract text from JSON response', async () => {
        const jsonResponse = JSON.stringify({
            action: "reply",
            text: "Extracted message"
        });

        mockGenerateContent.mockResolvedValue({
            candidates: [{
                content: {
                    parts: [{ text: jsonResponse }]
                }
            }],
            text: () => jsonResponse
        });

        const result = await generateStandardResponse('context', 'query');
        expect(result).toBe('Extracted message');
        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringContaining('unwrapped JSON-structured response')
        ); // Verify logging happened
    });

    it('should return raw JSON if text field is missing in JSON object', async () => {
        const jsonResponse = JSON.stringify({
            other: "field"
        });

        mockGenerateContent.mockResolvedValue({
            candidates: [{
                content: {
                    parts: [{ text: jsonResponse }]
                }
            }],
            text: () => jsonResponse
        });

        const result = await generateStandardResponse('context', 'query');
        // parsed correctly but no 'text' field -> returns original text (which is the JSON string)
        expect(result).toBe(jsonResponse);
    });

    it('should handle malformed JSON gracefully', async () => {
        const malformed = '{ "text": "oops';

        mockGenerateContent.mockResolvedValue({
            candidates: [{
                content: {
                    parts: [{ text: malformed }]
                }
            }],
            text: () => malformed
        });

        const result = await generateStandardResponse('context', 'query');
        expect(result).toBe(malformed);
    });
});
