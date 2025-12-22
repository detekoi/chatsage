// tests/unit/components/llm/gemini/generation.test.js

jest.mock('../../../../../src/lib/logger.js');
jest.mock('../../../../../src/components/llm/gemini/core.js');
jest.mock('../../../../../src/components/llm/gemini/utils.js');

import {
    generateStandardResponse,
    generateSearchResponse,
    generateUnifiedResponse,
    summarizeText
} from '../../../../../src/components/llm/gemini/generation.js';
import { getGeminiClient, getGenAIInstance } from '../../../../../src/components/llm/gemini/core.js';
import { extractTextFromResponse } from '../../../../../src/components/llm/gemini/utils.js';
import logger from '../../../../../src/lib/logger.js';

describe('gemini/generation.js', () => {
    let mockGenerateContent;

    beforeEach(() => {
        jest.clearAllMocks();
        mockGenerateContent = jest.fn();
        getGeminiClient.mockReturnValue({ generateContent: mockGenerateContent });
        getGenAIInstance.mockReturnValue({ models: { generateContent: mockGenerateContent } });
        extractTextFromResponse.mockReturnValue('Mocked response text');
    });

    describe('generateStandardResponse', () => {
        it('should call generateContent with standard tools and structured output schema', async () => {
            extractTextFromResponse.mockReturnValue(JSON.stringify({ text: 'Mocked response text' }));

            mockGenerateContent.mockResolvedValue({
                candidates: [{ content: { parts: [{ text: JSON.stringify({ text: 'Mocked response text' }) }] } }]
            });

            const response = await generateStandardResponse('context', 'query');

            expect(mockGenerateContent).toHaveBeenCalledWith(expect.objectContaining({
                tools: expect.arrayContaining([expect.objectContaining({ functionDeclarations: expect.any(Array) })]),
                generationConfig: expect.objectContaining({
                    responseMimeType: 'application/json',
                    responseSchema: expect.any(Object)
                })
            }));
            expect(response).toBe('Mocked response text');
        });

        it('should return null on error', async () => {
            mockGenerateContent.mockRejectedValue(new Error('API Error'));
            const response = await generateStandardResponse('context', 'query');
            expect(response).toBeNull();
        });
    });

    describe('generateSearchResponse', () => {
        it('should call generateContent with search tool', async () => {
            mockGenerateContent.mockResolvedValue({
                candidates: [{ content: { parts: [{ text: 'Response' }] } }]
            });

            const response = await generateSearchResponse('context', 'query');

            expect(mockGenerateContent).toHaveBeenCalledWith(expect.objectContaining({
                tools: expect.arrayContaining([{ googleSearch: {} }])
            }));
            expect(response).toBe('Mocked response text');
        });
    });

    describe('generateUnifiedResponse', () => {
        it('should call generateContent with search tool', async () => {
            mockGenerateContent.mockResolvedValue({
                candidates: [{ content: { parts: [{ text: 'Response' }] } }]
            });

            const response = await generateUnifiedResponse('context', 'query');

            expect(mockGenerateContent).toHaveBeenCalledWith(expect.objectContaining({
                tools: expect.arrayContaining([{ googleSearch: {} }])
            }));
            expect(response).toBe('Mocked response text');
        });
    });

    describe('summarizeText', () => {
        it('should call generateContent on genAI instance', async () => {
            mockGenerateContent.mockResolvedValue({
                candidates: [{ content: { parts: [{ text: '{"summary": "Short summary"}' }] } }]
            });
            extractTextFromResponse.mockReturnValue('{"summary": "Short summary"}');

            const summary = await summarizeText('Long text to summarize');

            expect(mockGenerateContent).toHaveBeenCalled();
            expect(summary).toBe('Short summary');
        });
    });
});
