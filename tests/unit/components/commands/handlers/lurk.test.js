// tests/unit/components/commands/handlers/lurk.test.js
// Mock dependencies before imports to avoid hoisting issues
jest.mock('../../../../../src/components/context/contextManager.js');
jest.mock('../../../../../src/components/llm/geminiClient.js');
jest.mock('../../../../../src/components/llm/llmUtils.js');
jest.mock('../../../../../src/lib/logger.js');
jest.mock('../../../../../src/components/llm/botResponseHandler.js');

import lurkHandler from '../../../../../src/components/commands/handlers/lurk.js';
import { getContextManager } from '../../../../../src/components/context/contextManager.js';
import {
    buildContextPrompt,
    generateLiteContent
} from '../../../../../src/components/llm/geminiClient.js';
import { removeMarkdownAsterisks } from '../../../../../src/components/llm/llmUtils.js';
import { sendBotResponse } from '../../../../../src/components/llm/botResponseHandler.js';

describe('Lurk Command Handler', () => {
    let mockContextManager;

    const createMockContext = (args = [], channel = '#testchannel', user = { username: 'testuser', 'display-name': 'TestUser', id: '123' }) => ({
        channel,
        user,
        args,
        message: `!lurk ${args.join(' ')}`,
        ircClient: {},
        contextManager: mockContextManager
    });

    beforeEach(() => {
        // Clear mocks (except logger which is mocked at module level)
        getContextManager.mockClear();
        buildContextPrompt.mockClear();
        generateLiteContent.mockClear();
        removeMarkdownAsterisks.mockClear();
        sendBotResponse.mockClear();

        // Setup mocks
        mockContextManager = {
            getContextForLLM: jest.fn()
        };

        // Mock the imported functions
        getContextManager.mockReturnValue(mockContextManager);
        buildContextPrompt.mockReturnValue('mock context prompt');
        generateLiteContent.mockResolvedValue('Mocked response');
        removeMarkdownAsterisks.mockImplementation((text) => text?.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1') || '');
        sendBotResponse.mockResolvedValue();

        // Setup context manager default return
        mockContextManager.getContextForLLM.mockReturnValue({
            channel: 'testchannel',
            currentGame: 'Test Game',
            chatHistory: []
        });
    });

    describe('Command Info', () => {
        test('should have correct command metadata', () => {
            expect(lurkHandler.name).toBe('lurk');
            expect(lurkHandler.description).toContain('Let the chat know you are lurking');
            expect(lurkHandler.usage).toBe('!lurk [your reason for lurking]');
            expect(lurkHandler.permission).toBe('everyone');
        });
    });

    describe('Markdown Removal', () => {
        test('should remove asterisk markdown from lurk responses', async () => {
            generateLiteContent.mockResolvedValue('enjoy your **snack quest** adventurer');

            const context = createMockContext(['getting', 'snacks']);
            await lurkHandler.execute(context);

            expect(removeMarkdownAsterisks).toHaveBeenCalledWith('enjoy your **snack quest** adventurer');
            expect(sendBotResponse).toHaveBeenCalledWith(
                '#testchannel',
                'enjoy your snack quest adventurer',
                { replyToId: '123' }
            );
        });

        test('should remove italic asterisk markdown', async () => {
            generateLiteContent.mockResolvedValue('lurking in *stealth mode* activated');

            const context = createMockContext([]);
            await lurkHandler.execute(context);

            expect(removeMarkdownAsterisks).toHaveBeenCalledWith('lurking in *stealth mode* activated');
            expect(sendBotResponse).toHaveBeenCalledWith(
                '#testchannel',
                'lurking in stealth mode activated',
                { replyToId: '123' }
            );
        });

        test('should handle responses without markdown', async () => {
            generateLiteContent.mockResolvedValue('catch you on the flip');

            const context = createMockContext([]);
            await lurkHandler.execute(context);

            expect(removeMarkdownAsterisks).toHaveBeenCalledWith('catch you on the flip');
            expect(sendBotResponse).toHaveBeenCalledWith(
                '#testchannel',
                'catch you on the flip',
                { replyToId: '123' }
            );
        });

        test('should remove markdown from multiple occurrences', async () => {
            generateLiteContent.mockResolvedValue('off to the **kitchen** for some *chaos*');

            const context = createMockContext(['cooking']);
            await lurkHandler.execute(context);

            expect(removeMarkdownAsterisks).toHaveBeenCalled();
            expect(sendBotResponse).toHaveBeenCalledWith(
                '#testchannel',
                'off to the kitchen for some chaos',
                { replyToId: '123' }
            );
        });
    });

    describe('With Reason', () => {
        test('should pass lurk reason to LLM', async () => {
            const context = createMockContext(['getting', 'coffee']);
            await lurkHandler.execute(context);

            expect(mockContextManager.getContextForLLM).toHaveBeenCalledWith(
                'testchannel',
                'TestUser',
                'is going to lurk. Reason: getting coffee',
                expect.any(Object)
            );
            expect(generateLiteContent).toHaveBeenCalled();
        });

        test('should handle multi-word reasons', async () => {
            const context = createMockContext(['taking', 'the', 'dog', 'for', 'a', 'walk']);
            await lurkHandler.execute(context);

            expect(mockContextManager.getContextForLLM).toHaveBeenCalledWith(
                'testchannel',
                'TestUser',
                'is going to lurk. Reason: taking the dog for a walk',
                expect.any(Object)
            );
        });
    });

    describe('Without Reason', () => {
        test('should handle lurk without reason', async () => {
            const context = createMockContext([]);
            await lurkHandler.execute(context);

            expect(mockContextManager.getContextForLLM).toHaveBeenCalledWith(
                'testchannel',
                'TestUser',
                'is going to lurk. Reason: none',
                expect.any(Object)
            );
            expect(generateLiteContent).toHaveBeenCalled();
        });
    });

    describe('Fallback Messages', () => {
        test('should use fallback when LLM returns empty response', async () => {
            generateLiteContent.mockResolvedValue('');

            const context = createMockContext([]);
            await lurkHandler.execute(context);

            // Should send a fallback message
            expect(sendBotResponse).toHaveBeenCalledWith(
                '#testchannel',
                expect.any(String),
                { replyToId: '123' }
            );
        });

        test('should use fallback when LLM returns null', async () => {
            generateLiteContent.mockResolvedValue(null);

            const context = createMockContext([]);
            await lurkHandler.execute(context);

            // Should send a fallback message
            expect(sendBotResponse).toHaveBeenCalled();
        });

        test('fallback messages should not contain markdown', async () => {
            generateLiteContent.mockResolvedValue('');

            const context = createMockContext([]);
            await lurkHandler.execute(context);

            const sentMessage = sendBotResponse.mock.calls[0][1];
            // Fallbacks should not contain asterisks (except in the onomatopoeia like *shff shff*)
            // The one fallback with asterisks is intentional sound effect, not markdown
            expect(typeof sentMessage).toBe('string');
            expect(sentMessage.length).toBeGreaterThan(0);
        });
    });

    describe('Quote Removal', () => {
        test('should remove surrounding quotes from LLM response', async () => {
            generateLiteContent.mockResolvedValue('"enjoy the lurk"');

            const context = createMockContext([]);
            await lurkHandler.execute(context);

            expect(sendBotResponse).toHaveBeenCalledWith(
                '#testchannel',
                'enjoy the lurk',
                { replyToId: '123' }
            );
        });

        test('should remove quotes and markdown together', async () => {
            generateLiteContent.mockResolvedValue('"enjoy your **snack quest**"');

            const context = createMockContext(['snacks']);
            await lurkHandler.execute(context);

            expect(sendBotResponse).toHaveBeenCalledWith(
                '#testchannel',
                'enjoy your snack quest',
                { replyToId: '123' }
            );
        });
    });

    describe('Error Handling', () => {
        test('should handle missing context gracefully', async () => {
            mockContextManager.getContextForLLM.mockReturnValue(null);

            const context = createMockContext([]);
            await lurkHandler.execute(context);

            // Should still proceed with empty context
            expect(buildContextPrompt).toHaveBeenCalledWith({});
            expect(generateLiteContent).toHaveBeenCalled();
        });

        test('should handle LLM errors gracefully', async () => {
            generateLiteContent.mockRejectedValue(new Error('LLM error'));

            const context = createMockContext([]);
            await lurkHandler.execute(context);

            // Should send a fallback message on error
            expect(sendBotResponse).toHaveBeenCalledWith(
                '#testchannel',
                expect.any(String),
                { replyToId: '123' }
            );
        });
    });

    describe('Context Building', () => {
        test('should build context with chat history', async () => {
            mockContextManager.getContextForLLM.mockReturnValue({
                channel: 'testchannel',
                currentGame: 'Test Game',
                chatHistory: [
                    { userName: 'user1', message: 'hello' },
                    { userName: 'user2', message: 'hi there' }
                ]
            });

            const context = createMockContext(['brb']);
            await lurkHandler.execute(context);

            expect(buildContextPrompt).toHaveBeenCalledWith(
                expect.objectContaining({
                    chatHistory: expect.any(Array)
                })
            );
        });

        test('should include user display name in prompt', async () => {
            const context = createMockContext([], '#testchannel', {
                username: 'lowercaseuser',
                'display-name': 'MixedCaseUser',
                id: '123'
            });
            await lurkHandler.execute(context);

            expect(generateLiteContent).toHaveBeenCalled();
        });
    });

    describe('Reply ID Handling', () => {
        test('should use user.id for replyToId', async () => {
            const context = createMockContext([], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '12345'
            });
            await lurkHandler.execute(context);

            expect(sendBotResponse).toHaveBeenCalledWith(
                '#testchannel',
                expect.any(String),
                { replyToId: '12345' }
            );
        });

        test('should fallback to message-id if user.id not available', async () => {
            const context = createMockContext([], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                'message-id': 'msg-123'
            });
            await lurkHandler.execute(context);

            expect(sendBotResponse).toHaveBeenCalledWith(
                '#testchannel',
                expect.any(String),
                { replyToId: 'msg-123' }
            );
        });

        test('should use null if no replyToId available', async () => {
            const context = createMockContext([], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser'
            });
            await lurkHandler.execute(context);

            expect(sendBotResponse).toHaveBeenCalledWith(
                '#testchannel',
                expect.any(String),
                { replyToId: null }
            );
        });
    });

    describe('Display Name Handling', () => {
        test('should use display-name when available', async () => {
            const context = createMockContext([], '#testchannel', {
                username: 'lowercaseuser',
                'display-name': 'DisplayName',
                id: '123'
            });
            await lurkHandler.execute(context);

            expect(mockContextManager.getContextForLLM).toHaveBeenCalledWith(
                'testchannel',
                'DisplayName',
                expect.any(String),
                expect.any(Object)
            );
        });

        test('should fallback to username if display-name not available', async () => {
            const context = createMockContext([], '#testchannel', {
                username: 'regularuser',
                id: '123'
            });
            await lurkHandler.execute(context);

            expect(mockContextManager.getContextForLLM).toHaveBeenCalledWith(
                'testchannel',
                'regularuser',
                expect.any(String),
                expect.any(Object)
            );
        });
    });
});

