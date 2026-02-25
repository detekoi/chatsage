// tests/unit/lib/translationUtils.test.js

jest.mock('../../../src/lib/logger.js');
jest.mock('../../../src/components/llm/geminiClient.js');
jest.mock('../../../src/components/llm/gemini/core.js');

import * as translationUtils from '../../../src/lib/translationUtils.js';
import logger from '../../../src/lib/logger.js';
import { getGeminiClient } from '../../../src/components/llm/geminiClient.js';
import { getGenAIInstance } from '../../../src/components/llm/gemini/core.js';

const { translateText, cleanupTranslationUtils, SAME_LANGUAGE } = translationUtils;

describe('translationUtils', () => {
    let mockModel;
    let mockAI;

    // Helper: create a flash-lite detection response
    const createDetectResponse = (sameLanguage) => ({
        candidates: [{
            content: { parts: [{ text: JSON.stringify({ same_language: sameLanguage }) }] },
            finishReason: 'STOP'
        }]
    });

    // Helper: create a translation response
    const createTranslateResponse = (text) => ({
        candidates: [{
            content: { parts: [{ text }] },
            finishReason: 'STOP'
        }]
    });

    beforeEach(() => {
        jest.clearAllMocks();

        // Clear translation cache before each test
        cleanupTranslationUtils();

        // Setup translation model mock (getGeminiClient -> model.generateContent)
        mockModel = {
            generateContent: jest.fn()
        };
        getGeminiClient.mockReturnValue(mockModel);

        // Setup detection model mock (getGenAIInstance -> ai.models.generateContent)
        mockAI = {
            models: {
                generateContent: jest.fn().mockResolvedValue(createDetectResponse(false))
            }
        };
        getGenAIInstance.mockReturnValue(mockAI);

        // Mock process.env for tests
        process.env.NODE_ENV = 'test';
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
            mockAI.models.generateContent.mockResolvedValue(createDetectResponse(false));
            mockModel.generateContent.mockResolvedValue(createTranslateResponse('Hola mundo'));

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBe('Hola mundo');
            expect(mockAI.models.generateContent).toHaveBeenCalledTimes(1);
            expect(mockModel.generateContent).toHaveBeenCalledTimes(1);
        });

        it('should handle translation with metadata', async () => {
            mockAI.models.generateContent.mockResolvedValue(createDetectResponse(false));
            mockModel.generateContent.mockResolvedValue(createTranslateResponse('Bonjour le monde'));

            const result = await translateText('Hello world', 'French');

            expect(result).toBe('Bonjour le monde');
            expect(logger.info).toHaveBeenCalledWith(
                expect.objectContaining({
                    targetLanguage: 'French'
                }),
                'Successfully generated translation from Gemini.'
            );
        });

        it('should return SAME_LANGUAGE when text is already in target language', async () => {
            mockAI.models.generateContent.mockResolvedValue(createDetectResponse(true));

            const result = await translateText('Hello world', 'English');

            expect(result).toBe(SAME_LANGUAGE);
            // Should NOT call the translation model
            expect(mockModel.generateContent).not.toHaveBeenCalled();
        });

        it('should proceed with translation when detection fails', async () => {
            mockAI.models.generateContent.mockRejectedValue(new Error('Detection failed'));
            mockModel.generateContent.mockResolvedValue(createTranslateResponse('Hola mundo'));

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBe('Hola mundo');
            expect(logger.debug).toHaveBeenCalledWith(
                expect.objectContaining({ err: expect.any(Error) }),
                'Language detection failed, proceeding with translation.'
            );
        });

        it('should return null when translation API call fails', async () => {
            mockAI.models.generateContent.mockResolvedValue(createDetectResponse(false));
            mockModel.generateContent.mockRejectedValue(new Error('API Error'));

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBeNull();
            expect(logger.warn).toHaveBeenCalledWith(
                expect.objectContaining({ err: expect.any(Error) }),
                'Translation attempt1 failed.'
            );
        });

        it('should return null when response has no text', async () => {
            mockAI.models.generateContent.mockResolvedValue(createDetectResponse(false));
            mockModel.generateContent.mockResolvedValue({ candidates: [{}] });

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBeNull();
            expect(logger.warn).toHaveBeenCalledWith('Translation response missing extractable text.');
        });

        it('should return null when prompt is blocked', async () => {
            mockAI.models.generateContent.mockResolvedValue(createDetectResponse(false));
            mockModel.generateContent.mockResolvedValue({
                candidates: [{ finishReason: 'SAFETY' }],
                promptFeedback: { blockReason: 'HARM_CATEGORY_HARASSMENT' }
            });

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBeNull();
            expect(logger.warn).toHaveBeenCalledWith(
                { blockReason: 'HARM_CATEGORY_HARASSMENT' },
                'Translation prompt blocked by Gemini safety settings.'
            );
        });

        it('should clean quotation marks from translation', async () => {
            mockAI.models.generateContent.mockResolvedValue(createDetectResponse(false));
            mockModel.generateContent.mockResolvedValue(createTranslateResponse('"Hola mundo"'));

            const result = await translateText('Hello world', 'Spanish');

            expect(result).toBe('Hola mundo');
        });

        it('should retry with simplified prompt on failure', async () => {
            mockAI.models.generateContent.mockResolvedValue(createDetectResponse(false));
            // First attempt fails
            mockModel.generateContent
                .mockRejectedValueOnce(new Error('API Error'));
            // Second attempt succeeds
            mockModel.generateContent
                .mockResolvedValueOnce(createTranslateResponse('Hola mundo'));

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
