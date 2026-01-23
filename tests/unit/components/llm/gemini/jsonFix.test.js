
// tests/unit/components/llm/gemini/jsonFix.test.js
// Updated: generateStandardResponse now returns plain text (no JSON parsing)
// because Gemini 3 doesn't support combining structured JSON output with custom function tools

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


import { generateStandardResponse } from '../../../../../src/components/llm/gemini/generation.js';
import { getGeminiClient } from '../../../../../src/components/llm/gemini/core.js';

describe('generateStandardResponse plain text handling', () => {
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

    it('should return plain text response directly', async () => {
        const plainTextResponse = "Hello from the model";

        mockGenerateContent.mockResolvedValue({
            candidates: [{
                content: {
                    parts: [{ text: plainTextResponse }]
                }
            }],
            text: () => plainTextResponse
        });

        const result = await generateStandardResponse('context', 'query');
        expect(result).toBe('Hello from the model');
    });

    it('should trim whitespace from response', async () => {
        const responseWithWhitespace = "  Hello with spaces  \n";

        mockGenerateContent.mockResolvedValue({
            candidates: [{
                content: {
                    parts: [{ text: responseWithWhitespace }]
                }
            }],
            text: () => responseWithWhitespace
        });

        const result = await generateStandardResponse('context', 'query');
        expect(result).toBe('Hello with spaces');
    });

    it('should return null for empty response', async () => {
        mockGenerateContent.mockResolvedValue({
            candidates: [{
                content: {
                    parts: [{ text: '' }]
                }
            }],
            text: () => ''
        });

        const result = await generateStandardResponse('context', 'query');
        expect(result).toBeNull();
    });

    it('should return null for whitespace-only response', async () => {
        mockGenerateContent.mockResolvedValue({
            candidates: [{
                content: {
                    parts: [{ text: '   \n\t  ' }]
                }
            }],
            text: () => '   \n\t  '
        });

        const result = await generateStandardResponse('context', 'query');
        expect(result).toBeNull();
    });
});
