// tests/unit/lib/translationUtils.test.js

jest.mock('../../../src/lib/logger.js');
jest.mock('../../../src/components/llm/geminiClient.js');

import * as translationUtils from '../../../src/lib/translationUtils.js';
import logger from '../../../src/lib/logger.js';
import { getGeminiClient } from '../../../src/components/llm/geminiClient.js';

const { translateText, cleanupTranslationUtils } = translationUtils;

describe('translationUtils', () => {
    let mockGeminiClient;
    let mockModel;

    beforeEach(() => {
        jest.clearAllMocks();

        // Setup Gemini client mocks
        mockModel = {
            generateContent: jest.fn()
        };

        mockGeminiClient = {
            generateContent: jest.fn().mockReturnValue(mockModel)
        };

        getGeminiClient.mockReturnValue(mockGeminiClient);

        // Mock process.env for tests
        process.env.NODE_ENV = 'test';

        // Clear translation cache before each test
        // Note: In real implementation, we might need to expose a method to clear cache
    });

    afterEach(() => {
        // Clean up any intervals or timers
        cleanupTranslationUtils();

        // Clean up process.env
        delete process.env.NODE_ENV;
    });

    describe('translateText', () => {
        it('should return null for empty text input', async () => {
            const result = await translateText('', 'Spanish');

            expect(result).toBeNull();
            expect(logger.error).toHaveBeenCalledWith('translateText called with missing text or target language.');
        });

        it('should return null for missing target language', async () => {
            const result = await translateText('Hello world', '');

            expect(result).toBeNull();
            expect(logger.error).toHaveBeenCalledWith('translateText called with missing text or target language.');
        });

        it('should return null for both empty inputs', async () => {
            const result = await translateText('', '');

            expect(result).toBeNull();
            expect(logger.error).toHaveBeenCalledWith('translateText called with missing text or target language.');
        });

        it('should handle basic translation request', async () => {
            const mockResponse = {
                candidates: [{
                    content: { parts: [{ text: 'Hola mundo' }] },
                    finishReason: 'STOP'
                }]
            };

            mockModel.generateContent.mockResolvedValue(mockResponse);

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBe('Hola mundo');
            expect(mockModel.generateContent).toHaveBeenCalledTimes(1);
        });

        it('should handle translation with metadata', async () => {
            const mockResponse = {
                candidates: [{
                    content: { parts: [{ text: 'Bonjour le monde' }] },
                    finishReason: 'STOP'
                }]
            };

            mockModel.generateContent.mockResolvedValue(mockResponse);

            const result = await translateText('Hello world', 'French');

            expect(result).toBe('Bonjour le monde');
            expect(logger.info).toHaveBeenCalledWith(
                expect.objectContaining({
                    targetLanguage: 'French'
                }),
                'Successfully generated translation from Gemini.'
            );
        });

        it('should return null when API call fails', async () => {
            mockModel.generateContent.mockRejectedValue(new Error('API Error'));

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBeNull();
            expect(logger.warn).toHaveBeenCalledWith(
                expect.objectContaining({ err: expect.any(Error) }),
                'Translation attempt1 failed.'
            );
        });

        it('should return null when response has no text', async () => {
            const mockResponse = {
                candidates: [{}]
            };

            mockModel.generateContent.mockResolvedValue(mockResponse);

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBeNull();
            expect(logger.warn).toHaveBeenCalledWith('Translation response missing extractable text.');
        });

        it('should return null when prompt is blocked', async () => {
            const mockResponse = {
                candidates: [{
                    finishReason: 'SAFETY'
                }],
                promptFeedback: {
                    blockReason: 'HARM_CATEGORY_HARASSMENT'
                }
            };

            mockModel.generateContent.mockResolvedValue(mockResponse);

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBeNull();
            expect(logger.warn).toHaveBeenCalledWith(
                { blockReason: 'HARM_CATEGORY_HARASSMENT' },
                'Translation prompt blocked by Gemini safety settings.'
            );
        });

        it('should clean quotation marks from translation', async () => {
            const mockResponse = {
                candidates: [{
                    content: { parts: [{ text: '"Hola mundo"' }] },
                    finishReason: 'STOP'
                }]
            };

            mockModel.generateContent.mockResolvedValue(mockResponse);

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBe('Hola mundo');
        });

        it('should retry with simplified prompt on failure', async () => {
            // First attempt fails
            mockModel.generateContent
                .mockRejectedValueOnce(new Error('API Error'));

            // Second attempt succeeds
            const mockResponse = {
                candidates: [{
                    content: { parts: [{ text: 'Hola mundo' }] },
                    finishReason: 'STOP'
                }]
            };

            mockModel.generateContent
                .mockResolvedValueOnce(mockResponse);

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBe('Hola mundo');
            expect(mockModel.generateContent).toHaveBeenCalledTimes(2);
        });
    });

    describe('cleanupTranslationUtils', () => {
        it('should cleanup translation cache intervals', () => {
            // This test mainly verifies the function exists and doesn't throw
            expect(() => cleanupTranslationUtils()).not.toThrow();
        });
    });
});
