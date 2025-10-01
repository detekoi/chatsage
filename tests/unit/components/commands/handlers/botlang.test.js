// tests/unit/components/commands/handlers/botlang.test.js
// Mock dependencies before imports to avoid hoisting issues
jest.mock('../../../../../src/components/context/contextManager.js');
jest.mock('../../../../../src/lib/translationUtils.js');
jest.mock('../../../../../src/lib/logger.js');
jest.mock('../../../../../src/lib/ircSender.js');

import botLangHandler from '../../../../../src/components/commands/handlers/botlang.js';
import { getContextManager } from '../../../../../src/components/context/contextManager.js';
import { translateText } from '../../../../../src/lib/translationUtils.js';
import logger from '../../../../../src/lib/logger.js';
import { enqueueMessage } from '../../../../../src/lib/ircSender.js';

describe('BotLang Command Handler', () => {
    let mockContextManager;
    let mockLogger;
    let mockGetContextManager;
    let mockTranslateText;
    let mockEnqueueMessage;

    const createMockContext = (args = [], channel = '#testchannel', user = { username: 'testuser', id: '123' }) => ({
        channel,
        user,
        args,
        message: `!botlang ${args.join(' ')}`,
        ircClient: {},
        contextManager: mockContextManager,
        logger: mockLogger
    });

    beforeEach(() => {
        jest.clearAllMocks();

        // Setup mocks
        mockContextManager = {
            getBotLanguage: jest.fn(),
            setBotLanguage: jest.fn()
        };

        mockLogger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        };

        // Mock the imported functions
        getContextManager.mockReturnValue(mockContextManager);
        translateText.mockImplementation(() => Promise.resolve('translated text'));
        enqueueMessage.mockImplementation(() => Promise.resolve());

        // Mock logger methods
        logger.debug = mockLogger.debug;
        logger.info = mockLogger.info;
        logger.warn = mockLogger.warn;
        logger.error = mockLogger.error;

        // Setup local references for use in tests
        mockGetContextManager = getContextManager;
        mockTranslateText = translateText;
        mockEnqueueMessage = enqueueMessage;
    });

    describe('Command Info', () => {
        test('should have correct command metadata', () => {
            expect(botLangHandler.name).toBe('botlang');
            expect(botLangHandler.description).toContain('Set the language for the bot');
            expect(botLangHandler.usage).toContain('!botlang <language>');
            expect(botLangHandler.permission).toBe('moderator');
        });
    });

    describe('Status Check (!botlang status)', () => {
        test('should show current language when set', async () => {
            mockContextManager.getBotLanguage.mockReturnValue('spanish');

            const context = createMockContext(['status']);
            await botLangHandler.execute(context);

            expect(mockContextManager.getBotLanguage).toHaveBeenCalledWith('testchannel');
            expect(mockEnqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Bot is currently set to speak spanish.',
                { replyToId: '123' }
            );
        });

        test('should show default when no language set', async () => {
            mockContextManager.getBotLanguage.mockReturnValue(null);

            const context = createMockContext(['status']);
            await botLangHandler.execute(context);

            expect(mockContextManager.getBotLanguage).toHaveBeenCalledWith('testchannel');
            expect(mockEnqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Bot is currently set to speak English (default).',
                { replyToId: '123' }
            );
        });
    });

    describe('Reset Language (!botlang off)', () => {
        test('should reset language to null with "off"', async () => {
            const context = createMockContext(['off']);
            await botLangHandler.execute(context);

            expect(mockContextManager.setBotLanguage).toHaveBeenCalledWith('testchannel', null);
            expect(mockEnqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Bot language has been reset to English (default).',
                { replyToId: '123' }
            );
        });

        test('should reset language to null with "default"', async () => {
            const context = createMockContext(['default']);
            await botLangHandler.execute(context);

            expect(mockContextManager.setBotLanguage).toHaveBeenCalledWith('testchannel', null);
            expect(mockEnqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Bot language has been reset to English (default).',
                { replyToId: '123' }
            );
        });

        test('should reset language to null with "english"', async () => {
            const context = createMockContext(['english']);
            await botLangHandler.execute(context);

            expect(mockContextManager.setBotLanguage).toHaveBeenCalledWith('testchannel', null);
            expect(mockEnqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Bot language has been reset to English (default).',
                { replyToId: '123' }
            );
        });
    });

    describe('Set New Language (!botlang <language>)', () => {
        test('should successfully set a valid language', async () => {
            const targetLanguage = 'french';
            mockTranslateText.mockResolvedValueOnce('Ceci est un test'); // Test translation
            mockTranslateText.mockResolvedValueOnce('Le langage du bot a été défini'); // Confirmation translation

            const context = createMockContext([targetLanguage]);
            await botLangHandler.execute(context);

            // Should test translation first
            expect(mockTranslateText).toHaveBeenCalledWith(
                'This is a test message to verify that "french" is a supported language.',
                targetLanguage
            );

            // Should set the language
            expect(mockContextManager.setBotLanguage).toHaveBeenCalledWith('testchannel', targetLanguage);

            // Should send English confirmation
            expect(mockEnqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Bot language has been set to french. All bot responses will now be in french. Use "!botlang off" to reset.',
                { replyToId: '123', skipTranslation: true }
            );

            // Should send translated confirmation
            expect(mockEnqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Le langage du bot a été défini',
                { replyToId: '123', skipTranslation: true }
            );
        });

        test('should handle multi-word language names', async () => {
            const targetLanguage = 'portuguese brazil';
            mockTranslateText.mockResolvedValueOnce('Isto é um teste'); // Test translation

            const context = createMockContext([targetLanguage]);
            await botLangHandler.execute(context);

            expect(mockContextManager.setBotLanguage).toHaveBeenCalledWith('testchannel', targetLanguage);
        });

        test('should reject unsupported language', async () => {
            const targetLanguage = 'invalidlang';
            mockTranslateText.mockResolvedValue(''); // Empty translation = unsupported

            const context = createMockContext([targetLanguage]);
            await botLangHandler.execute(context);

            expect(mockContextManager.setBotLanguage).not.toHaveBeenCalled();
            expect(mockEnqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Sorry, I couldn\'t translate to "invalidlang". Please check the language name and try again.',
                { replyToId: '123' }
            );
        });

        test('should handle translation API errors gracefully', async () => {
            const targetLanguage = 'french';
            mockTranslateText.mockRejectedValue(new Error('Translation API error'));

            const context = createMockContext([targetLanguage]);
            await botLangHandler.execute(context);

            expect(mockContextManager.setBotLanguage).not.toHaveBeenCalled();
            expect(mockEnqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Sorry, an error occurred while setting the bot language.',
                { replyToId: '123' }
            );
            expect(mockLogger.error).toHaveBeenCalled();
        });
    });

    describe('No Arguments (!botlang)', () => {
        test('should show current status and usage when no language set', async () => {
            mockContextManager.getBotLanguage.mockReturnValue(null);

            const context = createMockContext([]);
            await botLangHandler.execute(context);

            expect(mockContextManager.getBotLanguage).toHaveBeenCalledWith('testchannel');
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Bot is currently set to speak English (default). Use "!botlang <language>" to change.',
                { replyToId: '123' }
            );
        });

        test('should show current status and usage when language is set', async () => {
            mockContextManager.getBotLanguage.mockReturnValue('german');

            const context = createMockContext([]);
            await botLangHandler.execute(context);

            expect(mockContextManager.getBotLanguage).toHaveBeenCalledWith('testchannel');
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Bot is currently set to speak german. Use "!botlang off" to reset to English or "!botlang <language>" to change.',
                { replyToId: '123' }
            );
        });
    });

    describe('Edge Cases', () => {
        test('should handle empty translation gracefully', async () => {
            const targetLanguage = 'french';
            mockTranslateText.mockResolvedValue(null); // Null translation

            const context = createMockContext([targetLanguage]);
            await botLangHandler.execute(context);

            expect(mockContextManager.setBotLanguage).not.toHaveBeenCalled();
            expect(mockEnqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Sorry, I couldn\'t translate to "french". Please check the language name and try again.',
                { replyToId: '123' }
            );
        });

        test('should handle whitespace-only translation', async () => {
            const targetLanguage = 'french';
            mockTranslateText.mockResolvedValue('   '); // Whitespace only

            const context = createMockContext([targetLanguage]);
            await botLangHandler.execute(context);

            expect(mockContextManager.setBotLanguage).not.toHaveBeenCalled();
            expect(mockEnqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Sorry, I couldn\'t translate to "french". Please check the language name and try again.',
                { replyToId: '123' }
            );
        });

        test('should handle missing replyToId gracefully', async () => {
            const context = createMockContext(['status'], '#testchannel', { username: 'testuser' });
            await botLangHandler.execute(context);

            expect(mockEnqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.any(String),
                { replyToId: null }
            );
        });
    });

    describe('Translation Confirmation Messages', () => {
        test('should send both English and translated confirmations', async () => {
            const targetLanguage = 'spanish';
            const englishConfirm = 'Bot language has been set to spanish. All bot responses will now be in spanish. Use "!botlang off" to reset.';
            const translatedConfirm = 'El idioma del bot ha sido configurado a español.';

            mockTranslateText
                .mockResolvedValueOnce('Esto es un mensaje de prueba') // Test translation
                .mockResolvedValueOnce(translatedConfirm); // Confirmation translation

            const context = createMockContext([targetLanguage]);
            await botLangHandler.execute(context);

            expect(mockEnqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                englishConfirm,
                { replyToId: '123', skipTranslation: true }
            );
            expect(mockEnqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                translatedConfirm,
                { replyToId: '123', skipTranslation: true }
            );
        });

        test('should skip translated confirmation if translation fails', async () => {
            const targetLanguage = 'spanish';
            const englishConfirm = 'Bot language has been set to spanish. All bot responses will now be in spanish. Use "!botlang off" to reset.';

            mockTranslateText
                .mockResolvedValueOnce('Esto es un mensaje de prueba') // Test translation
                .mockRejectedValueOnce(new Error('Translation failed')); // Confirmation translation fails

            const context = createMockContext([targetLanguage]);
            await botLangHandler.execute(context);

            expect(mockEnqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                englishConfirm,
                { replyToId: '123', skipTranslation: true }
            );
            // Should not call enqueueMessage again for the failed translation
            expect(mockEnqueueMessage).toHaveBeenCalledTimes(1);
        });
    });
});
