// tests/unit/components/commands/handlers/search.test.js
// Mock dependencies before imports to avoid hoisting issues
jest.mock('../../../../../src/components/context/contextManager.js');
jest.mock('../../../../../src/components/llm/geminiClient.js');
jest.mock('../../../../../src/components/llm/llmUtils.js');
jest.mock('../../../../../src/lib/logger.js');
jest.mock('../../../../../src/lib/ircSender.js');

import searchHandler from '../../../../../src/components/commands/handlers/search.js';
import { getContextManager } from '../../../../../src/components/context/contextManager.js';
import {
    buildContextPrompt,
    summarizeText,
    generateSearchResponse
} from '../../../../../src/components/llm/geminiClient.js';
import { removeMarkdownAsterisks } from '../../../../../src/components/llm/llmUtils.js';
import { enqueueMessage } from '../../../../../src/lib/ircSender.js';

describe('Search Command Handler', () => {
    let mockContextManager;

    const createMockContext = (args = [], channel = '#testchannel', user = { username: 'testuser', 'display-name': 'TestUser', id: '123' }) => ({
        channel,
        user,
        args,
        message: `!search ${args.join(' ')}`,
        ircClient: {},
        contextManager: mockContextManager
    });

    beforeEach(() => {
        // Clear mocks (except logger which is mocked at module level)
        getContextManager.mockClear();
        buildContextPrompt.mockClear();
        generateSearchResponse.mockClear();
        summarizeText.mockClear();
        removeMarkdownAsterisks.mockClear();
        enqueueMessage.mockClear();

        // Setup mocks
        mockContextManager = {
            getContextForLLM: jest.fn()
        };

        // Mock the imported functions
        getContextManager.mockReturnValue(mockContextManager);
        buildContextPrompt.mockReturnValue('mock context prompt');
        generateSearchResponse.mockResolvedValue('mock search result');
        summarizeText.mockResolvedValue('summarized text');
        removeMarkdownAsterisks.mockImplementation((text) => text?.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1') || '');
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
            expect(searchHandler.name).toBe('search');
            expect(searchHandler.description).toContain('Searches the web');
            expect(searchHandler.usage).toBe('!search <your query>');
            expect(searchHandler.permission).toBe('everyone');
        });
    });

    describe('Uses generateSearchResponse (one-shot with Google Search grounding)', () => {
        test('should call generateSearchResponse with context and query', async () => {
            const context = createMockContext(['switch', '2', 'specs']);
            await searchHandler.execute(context);

            expect(generateSearchResponse).toHaveBeenCalledWith(
                'mock context prompt',
                expect.stringContaining('switch 2 specs')
            );
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'mock search result',
                { replyToId: '123' }
            );
        });

        test('should include username in the search query', async () => {
            const context = createMockContext(['test', 'query']);
            await searchHandler.execute(context);

            expect(generateSearchResponse).toHaveBeenCalledWith(
                'mock context prompt',
                expect.stringContaining('TestUser')
            );
        });
    });

    describe('Markdown Removal', () => {
        test('should remove asterisk markdown from search responses', async () => {
            generateSearchResponse.mockResolvedValue('The movie **Ladyhawke** was released in 1985');

            const context = createMockContext(['ladyhawke', 'movie']);
            await searchHandler.execute(context);

            expect(removeMarkdownAsterisks).toHaveBeenCalledWith('The movie **Ladyhawke** was released in 1985');
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'The movie Ladyhawke was released in 1985',
                { replyToId: '123' }
            );
        });

        test('should remove italic asterisk markdown', async () => {
            generateSearchResponse.mockResolvedValue('Check out *The Matrix* for sci-fi');

            const context = createMockContext(['sci-fi', 'movies']);
            await searchHandler.execute(context);

            expect(removeMarkdownAsterisks).toHaveBeenCalledWith('Check out *The Matrix* for sci-fi');
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Check out The Matrix for sci-fi',
                { replyToId: '123' }
            );
        });

        test('should handle responses without markdown', async () => {
            generateSearchResponse.mockResolvedValue('This is plain text result');

            const context = createMockContext(['plain', 'query']);
            await searchHandler.execute(context);

            expect(removeMarkdownAsterisks).toHaveBeenCalledWith('This is plain text result');
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'This is plain text result',
                { replyToId: '123' }
            );
        });

        test('should remove markdown from multiple occurrences', async () => {
            generateSearchResponse.mockResolvedValue('Try **Dark Souls**, *Elden Ring*, or **Bloodborne**');

            const context = createMockContext(['souls-like', 'games']);
            await searchHandler.execute(context);

            expect(removeMarkdownAsterisks).toHaveBeenCalled();
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Try Dark Souls, Elden Ring, or Bloodborne',
                { replyToId: '123' }
            );
        });
    });

    describe('No Arguments', () => {
        test('should show usage when no query provided', async () => {
            const context = createMockContext([]);
            await searchHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Please provide something to search for. Usage: !search <your query>',
                { replyToId: '123' }
            );
            expect(generateSearchResponse).not.toHaveBeenCalled();
        });
    });

    describe('Summarization', () => {
        test('should summarize long responses', async () => {
            const longResponse = 'a'.repeat(500); // Longer than 450 char limit
            generateSearchResponse.mockResolvedValue(longResponse);
            summarizeText.mockResolvedValue('summarized version');

            const context = createMockContext(['long', 'query']);
            await searchHandler.execute(context);

            expect(summarizeText).toHaveBeenCalledWith(longResponse, 400);
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'summarized version',
                { replyToId: '123' }
            );
        });

        test('should truncate if summarization fails', async () => {
            const longResponse = 'a'.repeat(500);
            generateSearchResponse.mockResolvedValue(longResponse);
            summarizeText.mockResolvedValue(''); // Failed summarization

            const context = createMockContext(['long', 'query']);
            await searchHandler.execute(context);

            expect(summarizeText).toHaveBeenCalled();
            // Should truncate with ...
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringMatching(/\.\.\.$/),
                { replyToId: '123' }
            );
        });

        test('should not summarize short responses', async () => {
            generateSearchResponse.mockResolvedValue('Short answer');

            const context = createMockContext(['short', 'query']);
            await searchHandler.execute(context);

            expect(summarizeText).not.toHaveBeenCalled();
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Short answer',
                { replyToId: '123' }
            );
        });
    });

    describe('Error Handling', () => {
        test('should handle missing context gracefully', async () => {
            mockContextManager.getContextForLLM.mockReturnValue(null);

            const context = createMockContext(['test', 'query']);
            await searchHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                "Sorry, I couldn't retrieve the current context to perform the search.",
                { replyToId: '123' }
            );
        });

        test('should handle search errors gracefully', async () => {
            generateSearchResponse.mockRejectedValue(new Error('Search error'));

            const context = createMockContext(['test', 'query']);
            await searchHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Sorry, an error occurred while searching.',
                { replyToId: '123' }
            );
        });

        test('should handle empty search result', async () => {
            generateSearchResponse.mockResolvedValue('');

            const context = createMockContext(['test', 'query']);
            await searchHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Sorry, I couldn\'t find information about "test query" right now.',
                { replyToId: '123' }
            );
        });

        test('should handle null search result', async () => {
            generateSearchResponse.mockResolvedValue(null);

            const context = createMockContext(['test', 'query']);
            await searchHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Sorry, I couldn\'t find information about "test query" right now.',
                { replyToId: '123' }
            );
        });
    });

    describe('User Prefix Stripping', () => {
        test('should strip username prefix from response', async () => {
            generateSearchResponse.mockResolvedValue('@testuser The answer is 42');
            removeMarkdownAsterisks.mockImplementation((text) => text);

            const context = createMockContext(['what', 'is', 'the', 'answer']);
            await searchHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'The answer is 42',
                { replyToId: '123' }
            );
        });

        test('should handle case-insensitive username stripping', async () => {
            generateSearchResponse.mockResolvedValue('TestUser: The answer is 42');
            removeMarkdownAsterisks.mockImplementation((text) => text);

            const context = createMockContext(['query'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '123'
            });
            await searchHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'The answer is 42',
                { replyToId: '123' }
            );
        });
    });

    describe('Reply ID Handling', () => {
        test('should use user.id for replyToId', async () => {
            const context = createMockContext(['test'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '12345'
            });
            await searchHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.any(String),
                { replyToId: '12345' }
            );
        });

        test('should fallback to message-id if user.id not available', async () => {
            const context = createMockContext(['test'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                'message-id': 'msg-123'
            });
            await searchHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.any(String),
                { replyToId: 'msg-123' }
            );
        });

        test('should use null if no replyToId available', async () => {
            const context = createMockContext(['test'], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser'
            });
            await searchHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.any(String),
                { replyToId: null }
            );
        });
    });
});
