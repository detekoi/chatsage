// tests/unit/components/commands/handlers/ask.test.js
// Mock dependencies before imports to avoid hoisting issues
jest.mock('../../../../../src/components/context/contextManager.js');
jest.mock('../../../../../src/components/llm/geminiClient.js');
jest.mock('../../../../../src/components/llm/llmUtils.js');
jest.mock('../../../../../src/lib/timeUtils.js');
jest.mock('../../../../../src/lib/logger.js');
jest.mock('../../../../../src/lib/ircSender.js');

import askHandler from '../../../../../src/components/commands/handlers/ask.js';
import { getContextManager } from '../../../../../src/components/context/contextManager.js';
import {
    buildContextPrompt,
    generateSearchResponse,
    generateStandardResponse,
    decideSearchWithStructuredOutput
} from '../../../../../src/components/llm/geminiClient.js';
import { removeMarkdownAsterisks, getUserFriendlyErrorMessage } from '../../../../../src/components/llm/llmUtils.js';
import { enqueueMessage } from '../../../../../src/lib/ircSender.js';

describe('Ask Command Handler', () => {
    let mockContextManager;

    const createMockContext = (args = [], channel = '#testchannel', user = { username: 'testuser', 'display-name': 'TestUser', id: '123' }) => ({
        channel,
        user,
        args,
        message: `!ask ${args.join(' ')}`,
        ircClient: {},
        contextManager: mockContextManager
    });

    beforeEach(() => {
        // Clear mocks (except logger which is mocked at module level)
        getContextManager.mockClear();
        buildContextPrompt.mockClear();
        generateSearchResponse.mockClear();
        generateStandardResponse.mockClear();
        decideSearchWithStructuredOutput.mockClear();
        removeMarkdownAsterisks.mockClear();
        getUserFriendlyErrorMessage.mockClear();
        enqueueMessage.mockClear();

        // Setup mocks
        mockContextManager = {
            getContextForLLM: jest.fn()
        };

        // Mock the imported functions
        getContextManager.mockReturnValue(mockContextManager);
        buildContextPrompt.mockReturnValue('mock context prompt');
        generateSearchResponse.mockResolvedValue('mock search response');
        generateStandardResponse.mockResolvedValue('mock standard response');
        decideSearchWithStructuredOutput.mockResolvedValue({ searchNeeded: false });
        removeMarkdownAsterisks.mockImplementation((text) => text?.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1') || '');
        getUserFriendlyErrorMessage.mockReturnValue('Sorry, an error occurred while processing your question.');
        enqueueMessage.mockResolvedValue();

        // Setup context manager default return
        mockContextManager.getContextForLLM.mockReturnValue({
            channel: 'testchannel',
            currentGame: 'Test Game',
            chatHistory: []
        });
    });

    describe('Command Info', () => {
        test('should have correct command metadata', () => {
            expect(askHandler.name).toBe('ask');
            expect(askHandler.description).toContain('Ask ChatSage a question');
            expect(askHandler.usage).toBe('!ask <your question>');
            expect(askHandler.permission).toBe('everyone');
        });
    });

    describe('Markdown Removal', () => {
        test('should remove asterisk markdown from standard responses', async () => {
            generateStandardResponse.mockResolvedValue('The movie **Ladyhawke** is a classic');
            decideSearchWithStructuredOutput.mockResolvedValue({ searchNeeded: false });

            const context = createMockContext(['what', 'is', 'ladyhawke']);
            await askHandler.execute(context);

            expect(removeMarkdownAsterisks).toHaveBeenCalledWith('The movie **Ladyhawke** is a classic');
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'The movie Ladyhawke is a classic',
                { replyToId: '123' }
            );
        });

        test('should remove asterisk markdown from search responses', async () => {
            generateSearchResponse.mockResolvedValue('Check out *The Matrix* and **Inception**');
            decideSearchWithStructuredOutput.mockResolvedValue({ searchNeeded: true });

            const context = createMockContext(['what', 'movies', 'to', 'watch']);
            await askHandler.execute(context);

            expect(removeMarkdownAsterisks).toHaveBeenCalledWith('Check out *The Matrix* and **Inception**');
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Check out The Matrix and Inception',
                { replyToId: '123' }
            );
        });

        test('should handle responses without markdown', async () => {
            generateStandardResponse.mockResolvedValue('This is plain text');
            decideSearchWithStructuredOutput.mockResolvedValue({ searchNeeded: false });

            const context = createMockContext(['test', 'question']);
            await askHandler.execute(context);

            expect(removeMarkdownAsterisks).toHaveBeenCalledWith('This is plain text');
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'This is plain text',
                { replyToId: '123' }
            );
        });

        test('should remove markdown from responses with multiple titles', async () => {
            generateStandardResponse.mockResolvedValue('Try **Dark Souls** or *Elden Ring* for **RPGs**');
            decideSearchWithStructuredOutput.mockResolvedValue({ searchNeeded: false });

            const context = createMockContext(['game', 'recommendations']);
            await askHandler.execute(context);

            expect(removeMarkdownAsterisks).toHaveBeenCalled();
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Try Dark Souls or Elden Ring for RPGs',
                { replyToId: '123' }
            );
        });
    });

    describe('No Arguments', () => {
        test('should show usage when no question provided', async () => {
            const context = createMockContext([]);
            await askHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Please ask a question after the command. Usage: !ask <your question>',
                { replyToId: '123' }
            );
            expect(generateStandardResponse).not.toHaveBeenCalled();
        });
    });

    describe('Greeting Handling', () => {
        test('should respond to simple greeting without LLM call', async () => {
            const context = createMockContext(['hi']);
            await askHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                "Hey there! What's on your mind?",
                { replyToId: '123' }
            );
            expect(generateStandardResponse).not.toHaveBeenCalled();
            expect(generateSearchResponse).not.toHaveBeenCalled();
        });

        test('should handle various greeting types', async () => {
            const greetings = ['hello', 'hey', 'sup', 'yo'];
            
            for (const greeting of greetings) {
                jest.clearAllMocks();
                const context = createMockContext([greeting]);
                await askHandler.execute(context);

                expect(enqueueMessage).toHaveBeenCalled();
                expect(generateStandardResponse).not.toHaveBeenCalled();
            }
        });
    });

    describe('Search Decision', () => {
        test('should use search when search is needed', async () => {
            decideSearchWithStructuredOutput.mockResolvedValue({ searchNeeded: true });
            generateSearchResponse.mockResolvedValue('Search result');

            const context = createMockContext(['current', 'weather', 'in', 'tokyo']);
            await askHandler.execute(context);

            expect(generateSearchResponse).toHaveBeenCalled();
            expect(generateStandardResponse).not.toHaveBeenCalled();
        });

        test('should use standard response when search not needed', async () => {
            decideSearchWithStructuredOutput.mockResolvedValue({ searchNeeded: false });
            generateStandardResponse.mockResolvedValue('Standard answer');

            const context = createMockContext(['what', 'is', '2+2']);
            await askHandler.execute(context);

            expect(generateStandardResponse).toHaveBeenCalled();
            expect(generateSearchResponse).not.toHaveBeenCalled();
        });

        test('should fallback to standard if search fails', async () => {
            decideSearchWithStructuredOutput.mockResolvedValue({ searchNeeded: true });
            generateSearchResponse.mockResolvedValue(null);
            generateStandardResponse.mockResolvedValue('Fallback answer');

            const context = createMockContext(['test', 'query']);
            await askHandler.execute(context);

            expect(generateSearchResponse).toHaveBeenCalled();
            expect(generateStandardResponse).toHaveBeenCalled();
        });
    });

    describe('Error Handling', () => {
        test('should handle missing context gracefully', async () => {
            mockContextManager.getContextForLLM.mockReturnValue(null);

            const context = createMockContext(['test', 'question']);
            await askHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                "Sorry, I couldn't retrieve the current context.",
                { replyToId: '123' }
            );
        });

        test('should handle LLM errors gracefully', async () => {
            generateStandardResponse.mockRejectedValue(new Error('LLM error'));
            decideSearchWithStructuredOutput.mockResolvedValue({ searchNeeded: false });

            const context = createMockContext(['test', 'question']);
            await askHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Sorry, an error occurred while processing your question.',
                { replyToId: '123' }
            );
        });

        test('should handle empty LLM response', async () => {
            generateStandardResponse.mockResolvedValue('');
            decideSearchWithStructuredOutput.mockResolvedValue({ searchNeeded: false });

            const context = createMockContext(['test', 'question']);
            await askHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                "Sorry, I couldn't find or generate an answer for that right now.",
                { replyToId: '123' }
            );
        });
    });

    describe('User Prefix Stripping', () => {
        test('should strip username prefix from response', async () => {
            generateStandardResponse.mockResolvedValue('@testuser The answer is 42');
            decideSearchWithStructuredOutput.mockResolvedValue({ searchNeeded: false });
            removeMarkdownAsterisks.mockImplementation((text) => text);

            const context = createMockContext(['what', 'is', 'the', 'answer']);
            await askHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'The answer is 42',
                { replyToId: '123' }
            );
        });
    });

    describe('Reply ID Handling', () => {
        test('should use user.id for replyToId', async () => {
            generateStandardResponse.mockResolvedValue('Response');
            decideSearchWithStructuredOutput.mockResolvedValue({ searchNeeded: false });

            const context = createMockContext(['test'], '#testchannel', { 
                username: 'testuser', 
                'display-name': 'TestUser',
                id: '12345' 
            });
            await askHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.any(String),
                { replyToId: '12345' }
            );
        });

        test('should fallback to message-id if user.id not available', async () => {
            generateStandardResponse.mockResolvedValue('Response');
            decideSearchWithStructuredOutput.mockResolvedValue({ searchNeeded: false });

            const context = createMockContext(['test'], '#testchannel', { 
                username: 'testuser',
                'display-name': 'TestUser',
                'message-id': 'msg-123'
            });
            await askHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.any(String),
                { replyToId: 'msg-123' }
            );
        });

        test('should use null if no replyToId available', async () => {
            generateStandardResponse.mockResolvedValue('Response');
            decideSearchWithStructuredOutput.mockResolvedValue({ searchNeeded: false });

            const context = createMockContext(['test'], '#testchannel', { 
                username: 'testuser',
                'display-name': 'TestUser'
            });
            await askHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.any(String),
                { replyToId: null }
            );
        });
    });
});

