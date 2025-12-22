
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

    it('should extract text from consistent structured JSON response', async () => {
        const jsonResponse = JSON.stringify({
            text: "Hello from structured output"
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
        expect(result).toBe('Hello from structured output');
    });

    it('should return null if valid JSON but missing text field', async () => {
        const jsonResponse = JSON.stringify({
            somethingElse: "oops"
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
        expect(result).toBeNull();
    });

    it('should return null (and log warning) on malformed JSON', async () => {
        const malformed = '{ "text": "oops...';

        mockGenerateContent.mockResolvedValue({
            candidates: [{
                content: {
                    parts: [{ text: malformed }]
                }
            }],
            text: () => malformed
        });

        const result = await generateStandardResponse('context', 'query');
        expect(result).toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ rawJsonText: malformed }),
            expect.stringContaining('Failed to parse structured output')
        );
    });
});
