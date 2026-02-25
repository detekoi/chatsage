// tests/unit/lib/translationUtils.test.js

jest.mock('../../../src/lib/logger.js');
jest.mock('../../../src/components/llm/gemini/core.js');

import * as translationUtils from '../../../src/lib/translationUtils.js';
import logger from '../../../src/lib/logger.js';
import { getGenAIInstance } from '../../../src/components/llm/gemini/core.js';

const { translateText, cleanupTranslationUtils, SAME_LANGUAGE } = translationUtils;

describe('translationUtils', () => {
    let mockAI;

    // Helper: create a structured response with same_language + translated_text
    const createStructuredResponse = (sameLanguage, translatedText = '') => ({
        candidates: [{
            content: { parts: [{ text: JSON.stringify({ same_language: sameLanguage, translated_text: translatedText }) }] },
            finishReason: 'STOP'
        }]
    });

    // Helper: create a plain-text response (for attempt 2 fallback)
    const createPlainTextResponse = (text) => ({
        candidates: [{
            content: { parts: [{ text }] },
            finishReason: 'STOP'
        }]
    });

    beforeEach(() => {
        jest.clearAllMocks();
        cleanupTranslationUtils();

        // Single mock: flash-lite via getGenAIInstance -> ai.models.generateContent
        mockAI = {
            models: {
                generateContent: jest.fn()
            }
        };
        getGenAIInstance.mockReturnValue(mockAI);

        process.env.NODE_ENV = 'test';
    });

    afterEach(() => {
        cleanupTranslationUtils();
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

        it('should handle basic translation in a single call', async () => {
            mockAI.models.generateContent.mockResolvedValue(
                createStructuredResponse(false, 'Hola mundo')
            );

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBe('Hola mundo');
            // Only one API call (single flash-lite call handles both detection + translation)
            expect(mockAI.models.generateContent).toHaveBeenCalledTimes(1);
        });

        it('should log success with correct metadata', async () => {
            mockAI.models.generateContent.mockResolvedValue(
                createStructuredResponse(false, 'Bonjour le monde')
            );

            const result = await translateText('Hello world', 'French');

            expect(result).toBe('Bonjour le monde');
            expect(logger.info).toHaveBeenCalledWith(
                expect.objectContaining({
                    targetLanguage: 'French'
                }),
                'Successfully generated translation from flash-lite.'
            );
        });

        it('should return SAME_LANGUAGE when text is already in target language', async () => {
            mockAI.models.generateContent.mockResolvedValue(
                createStructuredResponse(true, '')
            );

            const result = await translateText('Hello world', 'English');

            expect(result).toBe(SAME_LANGUAGE);
            // Only one call — detected same language and stopped
            expect(mockAI.models.generateContent).toHaveBeenCalledTimes(1);
        });

        it('should return null when both attempts fail', async () => {
            mockAI.models.generateContent.mockRejectedValue(new Error('API Error'));

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBeNull();
            // Two calls: attempt 1 (structured) fails, attempt 2 (plain text) fails
            expect(mockAI.models.generateContent).toHaveBeenCalledTimes(2);
        });

        it('should return null when response has no text', async () => {
            mockAI.models.generateContent.mockResolvedValue({ candidates: [{}] });

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBeNull();
            expect(logger.warn).toHaveBeenCalledWith('Translation response missing extractable text.');
        });

        it('should clean quotation marks from translation', async () => {
            mockAI.models.generateContent.mockResolvedValue(
                createStructuredResponse(false, '"Hola mundo"')
            );

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBe('Hola mundo');
        });

        it('should retry with plain-text prompt when structured fails', async () => {
            // First attempt (structured) fails
            mockAI.models.generateContent.mockRejectedValueOnce(new Error('Structured API Error'));
            // Second attempt (plain text) succeeds
            mockAI.models.generateContent.mockResolvedValueOnce(
                createPlainTextResponse('Hola mundo')
            );

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBe('Hola mundo');
            expect(mockAI.models.generateContent).toHaveBeenCalledTimes(2);
        });

        it('should fall back to raw text when JSON parsing fails', async () => {
            // Return non-JSON text in the structured response slot
            mockAI.models.generateContent.mockResolvedValue({
                candidates: [{
                    content: { parts: [{ text: 'Hola mundo' }] },
                    finishReason: 'STOP'
                }]
            });

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBe('Hola mundo');
        });

        it('should use cached translation on second call', async () => {
            mockAI.models.generateContent.mockResolvedValue(
                createStructuredResponse(false, 'Hola mundo')
            );

            // First call - hits API
            const result1 = await translateText('Hello world', 'Spanish');
            expect(result1).toBe('Hola mundo');
            expect(mockAI.models.generateContent).toHaveBeenCalledTimes(1);

            // Second call - should use cache
            const result2 = await translateText('Hello world', 'Spanish');
            expect(result2).toBe('Hola mundo');
            // Still 1 call — cache was used
            expect(mockAI.models.generateContent).toHaveBeenCalledTimes(1);
        });
    });

    describe('cleanupTranslationUtils', () => {
        it('should cleanup translation cache intervals', () => {
            expect(() => cleanupTranslationUtils()).not.toThrow();
        });
    });
});
