// tests/unit/components/commands/handlers/translate.test.js

jest.mock('../../../../../src/lib/logger.js');
jest.mock('../../../../../src/lib/ircSender.js');
jest.mock('../../../../../src/lib/translationUtils.js', () => ({
    translateText: jest.fn(),
    parseTranslateCommand: jest.fn(),
    COMMON_LANGUAGES: ['english', 'spanish', 'french', 'german']
}));
jest.mock('../../../../../src/components/context/contextManager.js');
jest.mock('../../../../../src/components/llm/geminiClient.js', () => ({
    buildContextPrompt: jest.fn().mockReturnValue('mock chat context')
}));

import translateHandler from '../../../../../src/components/commands/handlers/translate.js';
import { enqueueMessage } from '../../../../../src/lib/ircSender.js';
import { translateText, parseTranslateCommand } from '../../../../../src/lib/translationUtils.js';
import { getContextManager } from '../../../../../src/components/context/contextManager.js';
import logger from '../../../../../src/lib/logger.js';

describe('Translate Command Handler', () => {
    let mockContextManager;

    const createMockContext = (args = [], channel = '#testchannel', user = { username: 'testuser', 'display-name': 'TestUser', id: '123', mod: '0' }) => ({
        channel,
        user,
        args,
        message: `!translate ${args.join(' ')}`,
        ircClient: {},
        contextManager: mockContextManager
    });

    beforeEach(() => {
        jest.clearAllMocks();

        mockContextManager = {
            enableUserTranslation: jest.fn(),
            disableUserTranslation: jest.fn().mockReturnValue(false),
            disableAllTranslationsInChannel: jest.fn().mockReturnValue(0),
            getContextForLLM: jest.fn().mockReturnValue({ recentChatHistory: 'mock history' })
        };
        getContextManager.mockReturnValue(mockContextManager);

        enqueueMessage.mockResolvedValue();
        translateText.mockResolvedValue('Translated text');

        // Default mock for parseTranslateCommand - enable for self
        parseTranslateCommand.mockResolvedValue({
            action: 'enable',
            targetUser: null,
            language: 'spanish'
        });
    });

    describe('Command Info', () => {
        test('should have correct command metadata', () => {
            expect(translateHandler.name).toBe('translate');
            expect(translateHandler.description).toContain('Manage automatic message translation');
            expect(translateHandler.permission).toBe('everyone');
        });
    });

    describe('Usage Display', () => {
        test('should show usage when no arguments provided', async () => {
            const context = createMockContext([]);
            await translateHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Usage: !translate <language> [user] | !translate stop [user|all]',
                { replyToId: '123' }
            );
        });
    });

    describe('Self Translation', () => {
        test('should enable translation for self with language', async () => {
            parseTranslateCommand.mockResolvedValue({
                action: 'enable',
                targetUser: null,
                language: 'spanish'
            });
            translateText.mockResolvedValue('Traducción');
            const context = createMockContext(['spanish']);

            await translateHandler.execute(context);

            expect(mockContextManager.enableUserTranslation).toHaveBeenCalledWith(
                'testchannel',
                'testuser',
                'spanish'
            );
            expect(translateText).toHaveBeenCalled();
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('Okay, translating messages for TestUser into spanish'),
                { replyToId: '123' }
            );
        });

        test('should handle multi-word language names', async () => {
            parseTranslateCommand.mockResolvedValue({
                action: 'enable',
                targetUser: null,
                language: 'pig latin'
            });
            const context = createMockContext(['pig', 'latin']);

            await translateHandler.execute(context);

            expect(mockContextManager.enableUserTranslation).toHaveBeenCalledWith(
                'testchannel',
                'testuser',
                'pig latin'
            );
        });
    });

    describe('Stop Translation', () => {
        test('should stop translation for self', async () => {
            parseTranslateCommand.mockResolvedValue({
                action: 'stop',
                targetUser: null,
                language: null
            });
            mockContextManager.disableUserTranslation.mockReturnValue(true);
            const context = createMockContext(['stop']);

            await translateHandler.execute(context);

            expect(mockContextManager.disableUserTranslation).toHaveBeenCalledWith(
                'testchannel',
                'testuser'
            );
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Okay, stopped translating messages for TestUser.',
                { replyToId: '123' }
            );
        });

        test('should handle already stopped translation', async () => {
            parseTranslateCommand.mockResolvedValue({
                action: 'stop',
                targetUser: null,
                language: null
            });
            mockContextManager.disableUserTranslation.mockReturnValue(false);
            const context = createMockContext(['stop']);

            await translateHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Translation was already off for TestUser.',
                { replyToId: '123' }
            );
        });
    });

    describe('Mod/Broadcaster Controls', () => {
        test('should allow mod to stop translation for another user', async () => {
            parseTranslateCommand.mockResolvedValue({
                action: 'stop',
                targetUser: 'otheruser',
                language: null
            });
            mockContextManager.disableUserTranslation.mockReturnValue(true);

            const context = createMockContext(['stop', 'otheruser'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '123',
                mod: '1'
            });

            await translateHandler.execute(context);

            expect(mockContextManager.disableUserTranslation).toHaveBeenCalledWith(
                'testchannel',
                'otheruser'
            );
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Okay, stopped translating messages for otheruser.',
                { replyToId: '123' }
            );
        });

        test('should reject non-mod stopping translation for others', async () => {
            parseTranslateCommand.mockResolvedValue({
                action: 'stop',
                targetUser: 'otheruser',
                language: null
            });

            const context = createMockContext(['stop', 'otheruser'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '123',
                mod: '0'
            });

            await translateHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Only mods or the broadcaster can manage translation for other users.',
                { replyToId: '123' }
            );
            expect(mockContextManager.disableUserTranslation).not.toHaveBeenCalled();
        });

        test('should allow mod to enable translation for another user', async () => {
            parseTranslateCommand.mockResolvedValue({
                action: 'enable',
                targetUser: 'otheruser',
                language: 'spanish'
            });

            const context = createMockContext(['spanish', 'otheruser'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '123',
                mod: '1'
            });

            await translateHandler.execute(context);

            expect(mockContextManager.enableUserTranslation).toHaveBeenCalledWith(
                'testchannel',
                'otheruser',
                'spanish'
            );
        });

        test('should reject non-mod enabling translation for others', async () => {
            parseTranslateCommand.mockResolvedValue({
                action: 'enable',
                targetUser: 'otheruser',
                language: 'spanish'
            });

            const context = createMockContext(['spanish', 'otheruser'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '123',
                mod: '0'
            });

            await translateHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Only mods or the broadcaster can manage translation for other users.',
                { replyToId: '123' }
            );
        });

        test('should allow mod to stop all translations', async () => {
            parseTranslateCommand.mockResolvedValue({
                action: 'stop_all',
                targetUser: null,
                language: null
            });
            mockContextManager.disableAllTranslationsInChannel.mockReturnValue(5);
            const context = createMockContext(['stop', 'all'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '123',
                mod: '1'
            });

            await translateHandler.execute(context);

            expect(mockContextManager.disableAllTranslationsInChannel).toHaveBeenCalledWith(
                'testchannel'
            );
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Okay, stopped translations globally for 5 user(s).',
                { replyToId: '123' }
            );
        });

        test('should reject non-mod stopping all translations', async () => {
            parseTranslateCommand.mockResolvedValue({
                action: 'stop_all',
                targetUser: null,
                language: null
            });
            const context = createMockContext(['stop', 'all'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '123',
                mod: '0'
            });

            await translateHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Only mods or the broadcaster can stop all translations.',
                { replyToId: '123' }
            );
            expect(mockContextManager.disableAllTranslationsInChannel).not.toHaveBeenCalled();
        });
    });

    describe('LLM Parsing Integration', () => {
        test('should pass chat context to parseTranslateCommand', async () => {
            parseTranslateCommand.mockResolvedValue({
                action: 'enable',
                targetUser: null,
                language: 'spanish'
            });
            const context = createMockContext(['spanish']);

            await translateHandler.execute(context);

            expect(parseTranslateCommand).toHaveBeenCalledWith(
                'spanish',
                'testuser',
                'mock chat context'
            );
        });

        test('should handle LLM parsing with @mention format', async () => {
            parseTranslateCommand.mockResolvedValue({
                action: 'enable',
                targetUser: 'targetuser',
                language: 'french'
            });

            const context = createMockContext(['@targetuser', 'french'], '#testchannel', {
                username: 'moduser',
                'display-name': 'ModUser',
                id: '123',
                mod: '1'
            });

            await translateHandler.execute(context);

            expect(mockContextManager.enableUserTranslation).toHaveBeenCalledWith(
                'testchannel',
                'targetuser',
                'french'
            );
        });
    });

    describe('Error Handling', () => {
        test('should handle translation errors', async () => {
            parseTranslateCommand.mockResolvedValue({
                action: 'enable',
                targetUser: null,
                language: 'spanish'
            });
            const error = new Error('Translation error');
            mockContextManager.enableUserTranslation.mockImplementation(() => {
                throw error;
            });
            const context = createMockContext(['spanish']);

            await translateHandler.execute(context);

            expect(logger.error).toHaveBeenCalledWith(
                expect.objectContaining({ err: error }),
                'Error executing translate command action.'
            );
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Sorry, an error occurred while processing the translate command.',
                { replyToId: '123' }
            );
        });

        test('should handle missing language for enable', async () => {
            parseTranslateCommand.mockResolvedValue({
                action: 'enable',
                targetUser: null,
                language: null
            });
            const context = createMockContext(['']);

            await translateHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Please specify a language. Example: !translate spanish',
                { replyToId: '123' }
            );
        });
    });

    describe('Translation Confirmation', () => {
        test('should include translated confirmation when available', async () => {
            parseTranslateCommand.mockResolvedValue({
                action: 'enable',
                targetUser: null,
                language: 'spanish'
            });
            translateText.mockResolvedValue('Traducción confirmada');
            const context = createMockContext(['spanish']);

            await translateHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('/ Traducción confirmada'),
                { replyToId: '123' }
            );
        });

        test('should handle missing translation gracefully', async () => {
            parseTranslateCommand.mockResolvedValue({
                action: 'enable',
                targetUser: null,
                language: 'spanish'
            });
            translateText.mockResolvedValue(null);
            const context = createMockContext(['spanish']);

            await translateHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('Okay, translating messages'),
                { replyToId: '123' }
            );
        });
    });
});
