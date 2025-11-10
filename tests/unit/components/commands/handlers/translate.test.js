// tests/unit/components/commands/handlers/translate.test.js

jest.mock('../../../../../src/lib/logger.js');
jest.mock('../../../../../src/lib/ircSender.js');
jest.mock('../../../../../src/lib/translationUtils.js');
jest.mock('../../../../../src/components/context/contextManager.js');
jest.mock('../../../../../src/components/twitch/helixClient.js');

import translateHandler from '../../../../../src/components/commands/handlers/translate.js';
import { enqueueMessage } from '../../../../../src/lib/ircSender.js';
import { translateText } from '../../../../../src/lib/translationUtils.js';
import { getContextManager } from '../../../../../src/components/context/contextManager.js';
import { getUsersByLogin } from '../../../../../src/components/twitch/helixClient.js';
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
            disableAllTranslationsInChannel: jest.fn().mockReturnValue(0)
        };
        getContextManager.mockReturnValue(mockContextManager);

        enqueueMessage.mockResolvedValue();
        translateText.mockResolvedValue('Translated text');
        getUsersByLogin.mockResolvedValue([]);
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
                'Usage: !translate <language> | !translate stop | !translate <lang> <user> | !translate stop <user> | !translate stop all (Mods/Broadcaster)',
                { replyToId: '123' }
            );
        });
    });

    describe('Self Translation', () => {
        test('should enable translation for self with language', async () => {
            translateText.mockResolvedValue('Traducción');
            const context = createMockContext(['es']);

            await translateHandler.execute(context);

            expect(mockContextManager.enableUserTranslation).toHaveBeenCalledWith(
                'testchannel',
                'testuser',
                'es'
            );
            expect(translateText).toHaveBeenCalled();
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('Okay, translating messages for TestUser into es'),
                { replyToId: '123' }
            );
        });

        test('should handle multi-word language names', async () => {
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
            mockContextManager.disableUserTranslation.mockReturnValue(true);
            getUsersByLogin.mockResolvedValue([{ id: '456', login: 'otheruser' }]);
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
            getUsersByLogin.mockResolvedValue([{ id: '456', login: 'otheruser' }]);
            const context = createMockContext(['stop', 'otheruser'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '123',
                mod: '0'
            });

            await translateHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Only mods or the broadcaster can stop translation for other users.',
                { replyToId: '123' }
            );
            expect(mockContextManager.disableUserTranslation).not.toHaveBeenCalled();
        });

        test('should allow mod to enable translation for another user', async () => {
            getUsersByLogin.mockResolvedValue([{ id: '456', login: 'otheruser' }]);
            const context = createMockContext(['es', 'otheruser'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '123',
                mod: '1'
            });

            await translateHandler.execute(context);

            expect(mockContextManager.enableUserTranslation).toHaveBeenCalledWith(
                'testchannel',
                'otheruser',
                'es'
            );
        });

        test('should reject non-mod enabling translation for others', async () => {
            getUsersByLogin.mockResolvedValue([{ id: '456', login: 'otheruser' }]);
            const context = createMockContext(['es', 'otheruser'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '123',
                mod: '0'
            });

            await translateHandler.execute(context);

            // Should treat as self-translation since non-mod can't target others
            expect(mockContextManager.enableUserTranslation).toHaveBeenCalledWith(
                'testchannel',
                'testuser',
                'es otheruser'
            );
        });

        test('should allow mod to stop all translations', async () => {
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

    describe('Username Detection', () => {
        test('should strip @ prefix from username', async () => {
            mockContextManager.disableUserTranslation.mockReturnValue(true);
            getUsersByLogin.mockResolvedValue([{ id: '456', login: 'otheruser' }]);
            const context = createMockContext(['stop', '@otheruser'], '#testchannel', {
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
        });

        test('should verify username exists via Twitch API for mod targeting', async () => {
            getUsersByLogin.mockResolvedValue([{ id: '456', login: 'validuser' }]);
            const context = createMockContext(['es', 'validuser'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '123',
                mod: '1'
            });

            await translateHandler.execute(context);

            expect(getUsersByLogin).toHaveBeenCalledWith(['validuser']);
            expect(mockContextManager.enableUserTranslation).toHaveBeenCalledWith(
                'testchannel',
                'validuser',
                'es'
            );
        });

        test('should treat invalid username as language for mod', async () => {
            getUsersByLogin.mockResolvedValue([]);
            const context = createMockContext(['es', 'invaliduser'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '123',
                mod: '1'
            });

            await translateHandler.execute(context);

            // Should treat as language since user doesn't exist
            expect(mockContextManager.enableUserTranslation).toHaveBeenCalledWith(
                'testchannel',
                'testuser',
                'es invaliduser'
            );
        });

        test('should prevent targeting self when username matches', async () => {
            getUsersByLogin.mockResolvedValue([{ id: '123', login: 'testuser' }]);
            const context = createMockContext(['es', 'testuser'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '123',
                mod: '1'
            });

            await translateHandler.execute(context);

            // When username matches, it still treats all args as language (not targeting)
            expect(mockContextManager.enableUserTranslation).toHaveBeenCalledWith(
                'testchannel',
                'testuser',
                'es testuser'
            );
        });
    });

    describe('Error Handling', () => {
        test('should handle Twitch API errors gracefully', async () => {
            getUsersByLogin.mockRejectedValue(new Error('API error'));
            const context = createMockContext(['es', 'otheruser'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '123',
                mod: '1'
            });

            await translateHandler.execute(context);

            expect(logger.error).toHaveBeenCalled();
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Error checking username. Could not process command.',
                { replyToId: '123' }
            );
        });

        test('should handle translation errors', async () => {
            const error = new Error('Translation error');
            mockContextManager.enableUserTranslation.mockImplementation(() => {
                throw error;
            });
            const context = createMockContext(['es']);

            await translateHandler.execute(context);

            expect(logger.error).toHaveBeenCalledWith(
                { err: error, action: 'es', language: 'es', targetUsernameLower: 'testuser' },
                'Error executing translate command action.'
            );
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Sorry, an error occurred while processing the translate command.',
                { replyToId: '123' }
            );
        });

        test('should handle missing language for enable', async () => {
            // This shouldn't happen with current logic, but test defensive behavior
            mockContextManager.enableUserTranslation.mockImplementation(() => {
                throw new Error('Language required');
            });
            const context = createMockContext(['']);

            await translateHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Please specify a language.',
                { replyToId: '123' }
            );
        });
    });

    describe('Translation Confirmation', () => {
        test('should include translated confirmation when available', async () => {
            translateText.mockResolvedValue('Traducción confirmada');
            const context = createMockContext(['es']);

            await translateHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('/ Traducción confirmada'),
                { replyToId: '123' }
            );
        });

        test('should handle missing translation gracefully', async () => {
            translateText.mockResolvedValue(null);
            const context = createMockContext(['es']);

            await translateHandler.execute(context);

            expect(logger.warn).toHaveBeenCalledWith(
                'Could not translate confirmation message into es.'
            );
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('Okay, translating messages'),
                { replyToId: '123' }
            );
        });
    });
});

