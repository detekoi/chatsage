// tests/unit/handlers/messageHandlers.test.js

jest.mock('../../../src/lib/logger.js');
jest.mock('../../../src/lib/ircSender.js');
jest.mock('../../../src/lib/translationUtils.js', () => {
    const actual = jest.requireActual('../../../src/lib/translationUtils.js');
    return {
        ...actual,
        translateText: jest.fn(),
    };
});
jest.mock('../../../src/components/llm/llmUtils.js');
jest.mock('../../../src/config/index.js');
jest.mock('../../../src/constants/botConstants.js');
jest.mock('../../../src/components/context/contextManager.js');
jest.mock('../../../src/components/twitch/sharedChatManager.js');
jest.mock('../../../src/components/geo/geoGameManager.js');
jest.mock('../../../src/components/trivia/triviaGameManager.js');
jest.mock('../../../src/components/riddle/riddleGameManager.js');

import {
    isPrivilegedUser,
    handlePendingReport,
    handleStopTranslation,
    handleAutoTranslation,
    handleBotMention,
    processGameGuesses
} from '../../../src/handlers/messageHandlers.js';
import { enqueueMessage } from '../../../src/lib/ircSender.js';
import { translateText, SAME_LANGUAGE } from '../../../src/lib/translationUtils.js';
import { handleStandardLlmQuery } from '../../../src/components/llm/llmUtils.js';
import { STOP_TRANSLATION_TRIGGERS, getMentionStopTriggers } from '../../../src/constants/botConstants.js';
import { getContextManager } from '../../../src/components/context/contextManager.js';
import * as sharedChatManager from '../../../src/components/twitch/sharedChatManager.js';
import config from '../../../src/config/index.js';
import { getGeoGameManager } from '../../../src/components/geo/geoGameManager.js';
import { getTriviaGameManager } from '../../../src/components/trivia/triviaGameManager.js';
import { getRiddleGameManager } from '../../../src/components/riddle/riddleGameManager.js';

describe('Message Handlers', () => {
    let mockContextManager;
    let mockGeoManager;
    let mockTriviaManager;
    let mockRiddleManager;

    beforeEach(() => {
        jest.clearAllMocks();

        // Setup config mock
        config.twitch = { username: 'testbot' };

        // Setup context manager mock
        mockContextManager = {
            addMessage: jest.fn().mockResolvedValue(),
            disableAllTranslationsInChannel: jest.fn().mockReturnValue(0),
            disableUserTranslation: jest.fn().mockReturnValue(false),
            getBroadcasterId: jest.fn().mockResolvedValue(null)
        };
        getContextManager.mockReturnValue(mockContextManager);

        // Setup game manager mocks
        mockGeoManager = {
            finalizeReportWithRoundNumber: jest.fn().mockResolvedValue({ message: null }),
            processPotentialGuess: jest.fn()
        };
        mockTriviaManager = {
            finalizeReportWithRoundNumber: jest.fn().mockResolvedValue({ message: null }),
            processPotentialAnswer: jest.fn()
        };
        mockRiddleManager = {
            finalizeReportWithRoundNumber: jest.fn().mockResolvedValue({ message: null }),
            processPotentialAnswer: jest.fn()
        };

        getGeoGameManager.mockReturnValue(mockGeoManager);
        getTriviaGameManager.mockReturnValue(mockTriviaManager);
        getRiddleGameManager.mockReturnValue(mockRiddleManager);

        // Setup stop triggers mock
        STOP_TRANSLATION_TRIGGERS.length = 0;
        STOP_TRANSLATION_TRIGGERS.push('stop translating', 'stop translate');
        getMentionStopTriggers.mockReturnValue([
            '@testbot stop',
            '@testbot stop translating',
            '@testbot stop translate',
            '@testbot, stop translating'
        ]);

        // Setup shared chat manager mock
        sharedChatManager.getSessionForChannel.mockReturnValue(null);
        sharedChatManager.getSessionChannelLogins.mockReturnValue([]);
    });

    describe('isPrivilegedUser', () => {
        test('should return true for moderator with mod tag', () => {
            const tags = { mod: '1' };
            const channelName = 'testchannel';
            expect(isPrivilegedUser(tags, channelName)).toBe(true);
        });

        test('should return true for moderator with moderator badge', () => {
            const tags = { badges: { moderator: '1' } };
            const channelName = 'testchannel';
            expect(isPrivilegedUser(tags, channelName)).toBe(true);
        });

        test('should return true for broadcaster with broadcaster badge', () => {
            const tags = { badges: { broadcaster: '1' } };
            const channelName = 'testchannel';
            expect(isPrivilegedUser(tags, channelName)).toBe(true);
        });

        test('should return true when username matches channel name', () => {
            const tags = { username: 'testchannel' };
            const channelName = 'testchannel';
            expect(isPrivilegedUser(tags, channelName)).toBe(true);
        });

        test('should return false for regular user', () => {
            const tags = { username: 'regularuser' };
            const channelName = 'testchannel';
            expect(isPrivilegedUser(tags, channelName)).toBe(false);
        });

        test('should return false for empty tags', () => {
            const tags = {};
            const channelName = 'testchannel';
            expect(isPrivilegedUser(tags, channelName)).toBe(false);
        });
    });

    describe('handlePendingReport', () => {
        const createBaseParams = () => ({
            message: '123',
            cleanChannel: 'testchannel',
            lowerUsername: 'testuser',
            channel: '#testchannel',
            tags: { id: 'msg-123' },
            riddleManager: mockRiddleManager,
            triviaManager: mockTriviaManager,
            geoManager: mockGeoManager,
            contextManager: mockContextManager
        });

        test('should return false for non-numeric message', async () => {
            const result = await handlePendingReport({
                ...createBaseParams(),
                message: 'not a number'
            });
            expect(result).toBe(false);
            expect(mockRiddleManager.finalizeReportWithRoundNumber).not.toHaveBeenCalled();
        });

        test('should process riddle report when numeric message matches', async () => {
            mockRiddleManager.finalizeReportWithRoundNumber.mockResolvedValue({
                message: 'Riddle report processed'
            });

            const result = await handlePendingReport(createBaseParams());

            expect(result).toBe(true);
            expect(mockRiddleManager.finalizeReportWithRoundNumber).toHaveBeenCalledWith(
                'testchannel',
                'testuser',
                '123'
            );
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Riddle report processed'
            );
            expect(mockContextManager.addMessage).toHaveBeenCalled();
        });

        test('should process trivia report when riddle returns null', async () => {
            mockRiddleManager.finalizeReportWithRoundNumber.mockResolvedValue({ message: null });
            mockTriviaManager.finalizeReportWithRoundNumber.mockResolvedValue({
                message: 'Trivia report processed'
            });

            const result = await handlePendingReport(createBaseParams());

            expect(result).toBe(true);
            expect(mockTriviaManager.finalizeReportWithRoundNumber).toHaveBeenCalledWith(
                'testchannel',
                'testuser',
                '123'
            );
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Trivia report processed'
            );
        });

        test('should process geo report when riddle and trivia return null', async () => {
            mockRiddleManager.finalizeReportWithRoundNumber.mockResolvedValue({ message: null });
            mockTriviaManager.finalizeReportWithRoundNumber.mockResolvedValue({ message: null });
            mockGeoManager.finalizeReportWithRoundNumber.mockResolvedValue({
                message: 'Geo report processed'
            });

            const result = await handlePendingReport(createBaseParams());

            expect(result).toBe(true);
            expect(mockGeoManager.finalizeReportWithRoundNumber).toHaveBeenCalledWith(
                'testchannel',
                'testuser',
                '123'
            );
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Geo report processed'
            );
        });

        test('should return false when no game manager processes the report', async () => {
            mockRiddleManager.finalizeReportWithRoundNumber.mockResolvedValue({ message: null });
            mockTriviaManager.finalizeReportWithRoundNumber.mockResolvedValue({ message: null });
            mockGeoManager.finalizeReportWithRoundNumber.mockResolvedValue({ message: null });

            const result = await handlePendingReport(createBaseParams());

            expect(result).toBe(false);
        });

        test('should trim whitespace from numeric message', async () => {
            mockRiddleManager.finalizeReportWithRoundNumber.mockResolvedValue({
                message: 'Processed'
            });

            await handlePendingReport({
                ...createBaseParams(),
                message: '  456  '
            });

            expect(mockRiddleManager.finalizeReportWithRoundNumber).toHaveBeenCalledWith(
                'testchannel',
                'testuser',
                '456'
            );
        });
    });

    describe('handleStopTranslation', () => {
        const createBaseParams = () => ({
            message: '!translate stop',
            lowerMessage: '!translate stop',
            cleanChannel: 'testchannel',
            lowerUsername: 'testuser',
            channel: '#testchannel',
            tags: { id: 'msg-123' },
            isModOrBroadcaster: false,
            contextManager: mockContextManager
        });

        test('should return false when not a stop request', async () => {
            const result = await handleStopTranslation({
                ...createBaseParams(),
                message: 'regular message',
                lowerMessage: 'regular message'
            });
            expect(result).toBe(false);
        });

        test('should handle self stop via command', async () => {
            mockContextManager.disableUserTranslation.mockReturnValue(true);

            const result = await handleStopTranslation(createBaseParams());

            expect(result).toBe(true);
            expect(mockContextManager.disableUserTranslation).toHaveBeenCalledWith(
                'testchannel',
                'testuser'
            );
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Translation stopped.',
                { replyToId: 'msg-123' }
            );
        });

        test('should handle self stop when already stopped', async () => {
            mockContextManager.disableUserTranslation.mockReturnValue(false);

            const result = await handleStopTranslation(createBaseParams());

            expect(result).toBe(true);
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Translation was already off.',
                { replyToId: 'msg-123' }
            );
        });

        test('should handle mod stopping translation for another user', async () => {
            mockContextManager.disableUserTranslation.mockReturnValue(true);

            const result = await handleStopTranslation({
                ...createBaseParams(),
                message: '!translate stop otheruser',
                lowerMessage: '!translate stop otheruser',
                isModOrBroadcaster: true
            });

            expect(result).toBe(true);
            expect(mockContextManager.disableUserTranslation).toHaveBeenCalledWith(
                'testchannel',
                'otheruser'
            );
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Stopped translation for otheruser.',
                { replyToId: 'msg-123' }
            );
        });

        test('should process as self-stop when non-mod tries to stop others', async () => {
            // When non-mod uses !translate stop otheruser, it processes as self-stop (target is ignored)
            mockContextManager.disableUserTranslation.mockReturnValue(false);
            const result = await handleStopTranslation({
                ...createBaseParams(),
                message: '!translate stop otheruser',
                lowerMessage: '!translate stop otheruser',
                isModOrBroadcaster: false
            });

            expect(result).toBe(true);
            // Processes as self-stop, not as stopping other user
            expect(mockContextManager.disableUserTranslation).toHaveBeenCalledWith(
                'testchannel',
                'testuser'
            );
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Translation was already off.',
                { replyToId: 'msg-123' }
            );
        });

        test('should handle global stop for mods', async () => {
            mockContextManager.disableAllTranslationsInChannel.mockReturnValue(5);

            const result = await handleStopTranslation({
                ...createBaseParams(),
                message: '!translate stop all',
                lowerMessage: '!translate stop all',
                isModOrBroadcaster: true
            });

            expect(result).toBe(true);
            expect(mockContextManager.disableAllTranslationsInChannel).toHaveBeenCalledWith(
                'testchannel'
            );
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Okay, stopped translations globally for 5 user(s).',
                { replyToId: 'msg-123' }
            );
        });

        test('should reject global stop for non-mods', async () => {
            // When non-mod uses !translate stop all, it processes as self-stop, not global stop
            mockContextManager.disableUserTranslation.mockReturnValue(true);
            const result = await handleStopTranslation({
                ...createBaseParams(),
                message: '!translate stop all',
                lowerMessage: '!translate stop all',
                isModOrBroadcaster: false
            });

            // Function processes it as self-stop, so returns true
            expect(result).toBe(true);
            expect(mockContextManager.disableAllTranslationsInChannel).not.toHaveBeenCalled();
            expect(mockContextManager.disableUserTranslation).toHaveBeenCalledWith(
                'testchannel',
                'testuser'
            );
        });

        test('should handle natural language stop phrases', async () => {
            mockContextManager.disableUserTranslation.mockReturnValue(true);

            const result = await handleStopTranslation({
                ...createBaseParams(),
                message: 'stop translating',
                lowerMessage: 'stop translating'
            });

            expect(result).toBe(true);
            expect(mockContextManager.disableUserTranslation).toHaveBeenCalled();
        });

        test('should handle mention stop triggers', async () => {
            mockContextManager.disableUserTranslation.mockReturnValue(true);

            const result = await handleStopTranslation({
                ...createBaseParams(),
                message: '@testbot stop',
                lowerMessage: '@testbot stop'
            });

            expect(result).toBe(true);
            expect(mockContextManager.disableUserTranslation).toHaveBeenCalled();
        });

        test('should strip @ prefix from username in stop command', async () => {
            mockContextManager.disableUserTranslation.mockReturnValue(true);

            await handleStopTranslation({
                ...createBaseParams(),
                message: '!translate stop @otheruser',
                lowerMessage: '!translate stop @otheruser',
                isModOrBroadcaster: true
            });

            expect(mockContextManager.disableUserTranslation).toHaveBeenCalledWith(
                'testchannel',
                'otheruser'
            );
        });

        test('should add message to context before processing stop', async () => {
            await handleStopTranslation(createBaseParams());

            expect(mockContextManager.addMessage).toHaveBeenCalledWith(
                'testchannel',
                'testuser',
                '!translate stop',
                createBaseParams().tags
            );
        });
    });

    describe('handleAutoTranslation', () => {
        const createBaseParams = () => ({
            message: 'Hello world',
            cleanChannel: 'testchannel',
            lowerUsername: 'testuser',
            channel: '#testchannel',
            tags: { id: 'msg-123' },
            userState: { isTranslating: true, targetLanguage: 'es' },
            wasTranslateCommand: false
        });

        test('should translate when enabled for user', async () => {
            translateText.mockResolvedValue('Hola mundo');

            const result = await handleAutoTranslation(createBaseParams());

            expect(result).toBe(true);
            expect(translateText).toHaveBeenCalledWith('Hello world', 'es');
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                '🌐💬 Hola mundo',
                { replyToId: 'msg-123' }
            );
        });

        test('should return false when translation disabled', async () => {
            const result = await handleAutoTranslation({
                ...createBaseParams(),
                userState: { isTranslating: false, targetLanguage: 'es' }
            });

            expect(result).toBe(false);
            expect(translateText).not.toHaveBeenCalled();
        });

        test('should return false when target language not set', async () => {
            const result = await handleAutoTranslation({
                ...createBaseParams(),
                userState: { isTranslating: true, targetLanguage: null }
            });

            expect(result).toBe(false);
            expect(translateText).not.toHaveBeenCalled();
        });

        test('should return false for translate command itself', async () => {
            const result = await handleAutoTranslation({
                ...createBaseParams(),
                wasTranslateCommand: true
            });

            expect(result).toBe(false);
            expect(translateText).not.toHaveBeenCalled();
        });

        test('should return false when translation fails', async () => {
            translateText.mockResolvedValue(null);

            const result = await handleAutoTranslation(createBaseParams());

            expect(result).toBe(false);
            expect(enqueueMessage).not.toHaveBeenCalled();
        });

        test('should handle translation errors gracefully', async () => {
            translateText.mockRejectedValue(new Error('Translation error'));

            const result = await handleAutoTranslation(createBaseParams());

            expect(result).toBe(false);
            expect(enqueueMessage).not.toHaveBeenCalled();
        });

        test('should return false without warning when message is already in target language', async () => {
            translateText.mockResolvedValue(SAME_LANGUAGE);

            const result = await handleAutoTranslation(createBaseParams());

            expect(result).toBe(false);
            expect(enqueueMessage).not.toHaveBeenCalled();
        });

        test('should use message-id as fallback for replyToId', async () => {
            translateText.mockResolvedValue('Translated');
            await handleAutoTranslation({
                ...createBaseParams(),
                tags: { 'message-id': 'fallback-id' }
            });

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.any(String),
                { replyToId: 'fallback-id' }
            );
        });
    });

    describe('handleBotMention', () => {
        const createBaseParams = () => ({
            message: '@testbot hello',
            cleanChannel: 'testchannel',
            lowerUsername: 'testuser',
            displayName: 'TestUser',
            channel: '#testchannel',
            tags: { id: 'msg-123' }
        });

        beforeEach(() => {
            handleStandardLlmQuery.mockResolvedValue();
        });

        test('should handle direct mention', async () => {
            await handleBotMention(createBaseParams());

            expect(handleStandardLlmQuery).toHaveBeenCalledWith(
                '#testchannel',
                'testchannel',
                'TestUser',
                'testuser',
                'hello',
                'mention',
                'msg-123'
            );
        });

        test('should handle reply to bot', async () => {
            await handleBotMention({
                ...createBaseParams(),
                message: 'response message',
                tags: {
                    id: 'msg-123',
                    'reply-parent-user-login': 'testbot'
                }
            });

            expect(handleStandardLlmQuery).toHaveBeenCalled();
        });

        test('should skip commands starting with !', async () => {
            await handleBotMention({
                ...createBaseParams(),
                message: '!ping'
            });

            expect(handleStandardLlmQuery).not.toHaveBeenCalled();
        });

        test('should ignore empty mentions', async () => {
            await handleBotMention({
                ...createBaseParams(),
                message: '@testbot'
            });

            expect(handleStandardLlmQuery).not.toHaveBeenCalled();
        });

        test('should ignore empty replies', async () => {
            await handleBotMention({
                ...createBaseParams(),
                message: '',
                tags: {
                    id: 'msg-123',
                    'reply-parent-user-login': 'testbot'
                }
            });

            expect(handleStandardLlmQuery).not.toHaveBeenCalled();
        });

        test('should return early when not a mention or reply', async () => {
            await handleBotMention({
                ...createBaseParams(),
                message: 'regular message',
                tags: {}
            });

            expect(handleStandardLlmQuery).not.toHaveBeenCalled();
        });

        test('should handle shared chat session', async () => {
            mockContextManager.getBroadcasterId.mockResolvedValue('broadcaster-123');
            sharedChatManager.getSessionForChannel.mockReturnValue('session-456');
            sharedChatManager.getSessionChannelLogins.mockReturnValue(['channel1', 'channel2']);

            await handleBotMention(createBaseParams());

            expect(handleStandardLlmQuery).toHaveBeenCalledWith(
                '#testchannel',
                'testchannel',
                'TestUser',
                'testuser',
                'hello',
                'mention',
                'msg-123',
                'session-456'
            );
        });

        test('should strip mention prefix from message', async () => {
            await handleBotMention({
                ...createBaseParams(),
                message: '@testbot how are you?'
            });

            expect(handleStandardLlmQuery).toHaveBeenCalledWith(
                '#testchannel',
                'testchannel',
                'TestUser',
                'testuser',
                'how are you?',
                'mention',
                'msg-123'
            );
        });

        test('should use message-id as fallback for replyToId', async () => {
            await handleBotMention({
                ...createBaseParams(),
                tags: { 'message-id': 'fallback-id' }
            });

            expect(handleStandardLlmQuery).toHaveBeenCalledWith(
                '#testchannel',
                'testchannel',
                'TestUser',
                'testuser',
                'hello',
                'mention',
                'fallback-id'
            );
        });

        test('should handle mention in the middle of a message', async () => {
            await handleBotMention({
                ...createBaseParams(),
                message: 'hi @testbot how are you?'
            });

            expect(handleStandardLlmQuery).toHaveBeenCalledWith(
                '#testchannel',
                'testchannel',
                'TestUser',
                'testuser',
                'hi how are you?',
                'mention',
                'msg-123'
            );
        });

        test('should handle mention at the end of a message', async () => {
            await handleBotMention({
                ...createBaseParams(),
                message: 'hello @testbot'
            });

            expect(handleStandardLlmQuery).toHaveBeenCalledWith(
                '#testchannel',
                'testchannel',
                'TestUser',
                'testuser',
                'hello',
                'mention',
                'msg-123'
            );
        });
    });

    describe('processGameGuesses', () => {
        const createBaseParams = () => ({
            message: 'guess answer',
            cleanChannel: 'testchannel',
            lowerUsername: 'testuser',
            displayName: 'TestUser',
            geoManager: mockGeoManager,
            triviaManager: mockTriviaManager,
            riddleManager: mockRiddleManager
        });

        test('should pass guess to all game managers', () => {
            processGameGuesses(createBaseParams());

            expect(mockGeoManager.processPotentialGuess).toHaveBeenCalledWith(
                'testchannel',
                'testuser',
                'TestUser',
                'guess answer'
            );
            expect(mockTriviaManager.processPotentialAnswer).toHaveBeenCalledWith(
                'testchannel',
                'testuser',
                'TestUser',
                'guess answer'
            );
            expect(mockRiddleManager.processPotentialAnswer).toHaveBeenCalledWith(
                'testchannel',
                'testuser',
                'TestUser',
                'guess answer'
            );
        });

        test('should skip commands starting with !', () => {
            processGameGuesses({
                ...createBaseParams(),
                message: '!ping'
            });

            expect(mockGeoManager.processPotentialGuess).not.toHaveBeenCalled();
            expect(mockTriviaManager.processPotentialAnswer).not.toHaveBeenCalled();
            expect(mockRiddleManager.processPotentialAnswer).not.toHaveBeenCalled();
        });

        test('should handle empty message', () => {
            processGameGuesses({
                ...createBaseParams(),
                message: ''
            });

            expect(mockGeoManager.processPotentialGuess).toHaveBeenCalledWith(
                'testchannel',
                'testuser',
                'TestUser',
                ''
            );
        });
    });
});

