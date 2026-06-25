// tests/unit/lib/translationUtils.test.js

jest.mock('../../../src/lib/logger.js');
jest.mock('../../../src/components/llm/gemini/core.js');

import * as translationUtils from '../../../src/lib/translationUtils.js';
import logger from '../../../src/lib/logger.js';
import { generateLiteContent } from '../../../src/components/llm/gemini/core.js';

const { translateText, cleanupTranslationUtils, SAME_LANGUAGE } = translationUtils;

describe('translationUtils', () => {
    const createStructuredResponse = (sameLanguage, translatedText = '') => {
        return JSON.stringify({ same_language: sameLanguage, translated_text: translatedText });
    };

    // Helper: create a plain-text response (for attempt 2 fallback)
    const createPlainTextResponse = (text) => text;

    beforeEach(() => {
        jest.clearAllMocks();
        cleanupTranslationUtils();
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
            generateLiteContent.mockResolvedValue(
                createStructuredResponse(false, 'Hola mundo')
            );

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBe('Hola mundo');
            // Only one API call (single flash-lite call handles both detection + translation)
            expect(generateLiteContent).toHaveBeenCalledTimes(1);
        });

        it('should log success with correct metadata', async () => {
            generateLiteContent.mockResolvedValue(
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
            generateLiteContent.mockResolvedValue(
                createStructuredResponse(true, '')
            );

            const result = await translateText('Hello world', 'English');

            expect(result).toBe(SAME_LANGUAGE);
            // Only one call — detected same language and stopped
            expect(generateLiteContent).toHaveBeenCalledTimes(1);
        });

        it('should return null when both attempts fail', async () => {
            generateLiteContent.mockRejectedValue(new Error('API Error'));

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBeNull();
            // Two calls: attempt 1 (structured) fails, attempt 2 (plain text) fails
            expect(generateLiteContent).toHaveBeenCalledTimes(2);
        });

        it('should return null when response has no text', async () => {
            generateLiteContent.mockResolvedValue(null);

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBeNull();
            expect(logger.warn).toHaveBeenCalledWith('Translation response missing extractable text.');
        });

        it('should clean quotation marks from translation', async () => {
            generateLiteContent.mockResolvedValue(
                createStructuredResponse(false, '"Hola mundo"')
            );

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBe('Hola mundo');
        });

        it('should retry with plain-text prompt when structured fails', async () => {
            // First attempt (structured) fails
            generateLiteContent.mockRejectedValueOnce(new Error('Structured API Error'));
            // Second attempt (plain text) succeeds
            generateLiteContent.mockResolvedValueOnce(
                createPlainTextResponse('Hola mundo')
            );

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBe('Hola mundo');
            expect(generateLiteContent).toHaveBeenCalledTimes(2);
        });

        it('should fall back to raw text when JSON parsing fails', async () => {
            generateLiteContent.mockResolvedValue('Hola mundo');

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBe('Hola mundo');
        });

        it('should use cached translation on second call', async () => {
            generateLiteContent.mockResolvedValue(
                createStructuredResponse(false, 'Hola mundo')
            );

            // First call - hits API
            const result1 = await translateText('Hello world', 'Spanish');
            expect(result1).toBe('Hola mundo');
            expect(generateLiteContent).toHaveBeenCalledTimes(1);

            // Second call - should use cache
            const result2 = await translateText('Hello world', 'Spanish');
            expect(result2).toBe('Hola mundo');
            // Still 1 call — cache was used
            expect(generateLiteContent).toHaveBeenCalledTimes(1);
        });

        it('should return SAME_LANGUAGE when translation is nearly identical to input (similarity safeguard)', async () => {
            // LLM says same_language=false but the "translation" is basically the same text
            generateLiteContent.mockResolvedValue(
                createStructuredResponse(false, 'Denn, do you play Pokopia?')
            );

            const result = await translateText('Denn, do you play Pokopia?', 'English');

            expect(result).toBe(SAME_LANGUAGE);
            expect(logger.debug).toHaveBeenCalledWith(
                expect.objectContaining({ targetLanguage: 'English' }),
                'Translation too similar to original, treating as same language.'
            );
        });

        it('should return SAME_LANGUAGE for username-like text that gets echoed back', async () => {
            generateLiteContent.mockResolvedValue(
                createStructuredResponse(false, 'Ditto_Kak')
            );

            const result = await translateText('Ditto_Kak', 'English');

            expect(result).toBe(SAME_LANGUAGE);
        });

        it('should NOT trigger similarity safeguard for genuine translations', async () => {
            generateLiteContent.mockResolvedValue(
                createStructuredResponse(false, 'Hola, ¿juegas Pokopia?')
            );

            const result = await translateText('Denn, do you play Pokopia?', 'Spanish');

            expect(result).toBe('Hola, ¿juegas Pokopia?');
        });

        it('should include Twitch chat context in the translation prompt', async () => {
            generateLiteContent.mockResolvedValue(
                createStructuredResponse(true, '')
            );

            await translateText('Hello world', 'English');

            const prompt = generateLiteContent.mock.calls[0][0];
            expect(prompt).toContain('Twitch');
            expect(prompt).toContain('nicknames');
            expect(prompt).toContain('game terms');
        });

        it('should preserve profanity but sanitize extreme slurs', async () => {
            generateLiteContent.mockResolvedValue(
                createStructuredResponse(true, '')
            );

            await translateText('maricones', 'English');

            const prompt = generateLiteContent.mock.calls[0][0];
            expect(prompt).toContain('profanity');
            expect(prompt).toContain('slur');
        });
    });

    describe('cleanupTranslationUtils', () => {
        it('should cleanup translation cache intervals', () => {
            expect(() => cleanupTranslationUtils()).not.toThrow();
        });
    });
});
