// tests/unit/lib/translationUtils.test.js

jest.mock('../../../src/lib/logger.js');
jest.mock('../../../src/components/llm/llmClient.js');

import * as translationUtils from '../../../src/lib/translationUtils.js';
import logger from '../../../src/lib/logger.js';
import { generateLiteContent } from '../../../src/components/llm/llmClient.js';

const { translateText, cleanupTranslationUtils, SAME_LANGUAGE } = translationUtils;

describe('translationUtils', () => {
    const createStructuredResponse = (sameLanguage, translatedText = '') => {
        return JSON.stringify({ same_language: sameLanguage, translated_text: translatedText });
    };

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
            // Two structured attempts, both fail
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

        it('should retry with the same structured prompt when the first attempt fails', async () => {
            // generateLiteContent returns null when the API errors (e.g. a 503 after its own retries)
            generateLiteContent.mockResolvedValueOnce(null);
            generateLiteContent.mockResolvedValueOnce(createStructuredResponse(false, 'Hola mundo'));

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBe('Hola mundo');
            expect(generateLiteContent).toHaveBeenCalledTimes(2);
            const [firstPrompt, firstOptions] = generateLiteContent.mock.calls[0];
            const [secondPrompt, secondOptions] = generateLiteContent.mock.calls[1];
            expect(secondPrompt).toBe(firstPrompt);
            expect(secondOptions.responseSchema).toBe(firstOptions.responseSchema);
        });

        it('should never post unparseable model output as a translation', async () => {
            generateLiteContent.mockResolvedValue('"bai" is too short to translate without context.');

            const result = await translateText('bai', 'English');

            expect(result).toBeNull();
            expect(generateLiteContent).toHaveBeenCalledTimes(2);
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

    describe('translateText untranslatable handling', () => {
        it('should return null and log notes without retrying when the model marks text untranslatable', async () => {
            generateLiteContent.mockResolvedValue(JSON.stringify({
                same_language: false,
                untranslatable: true,
                translated_text: '',
                notes: '"bai" is too short to translate without context'
            }));

            const result = await translateText('bai', 'Simple English');

            expect(result).toBeNull();
            // A deliberate skip is final; no retry
            expect(generateLiteContent).toHaveBeenCalledTimes(1);
            expect(logger.info).toHaveBeenCalledWith(
                expect.objectContaining({ text: 'bai', notes: '"bai" is too short to translate without context' }),
                '[Translate] Model declined to translate; skipping.'
            );
        });

        it('should log notes but return only the translation when one is provided', async () => {
            generateLiteContent.mockResolvedValue(JSON.stringify({
                same_language: false,
                untranslatable: false,
                translated_text: 'Hola mundo',
                notes: 'Informal greeting'
            }));

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBe('Hola mundo');
            expect(logger.info).toHaveBeenCalledWith(
                expect.objectContaining({ notes: 'Informal greeting' }),
                '[Translate] Translation notes'
            );
        });

        it('should tell the model to keep commentary out of translated_text', async () => {
            generateLiteContent.mockResolvedValue(createStructuredResponse(true, ''));

            await translateText('Hello', 'Spanish');

            const prompt = generateLiteContent.mock.calls[0][0];
            expect(prompt).toContain('untranslatable');
            expect(prompt).toContain('notes');
        });
    });

    describe('cleanupTranslationUtils', () => {
        it('should cleanup translation cache intervals', () => {
            expect(() => cleanupTranslationUtils()).not.toThrow();
        });
    });
});
