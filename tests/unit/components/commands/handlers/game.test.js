// tests/unit/components/commands/handlers/game.test.js
// Mock dependencies before imports to avoid hoisting issues
jest.mock('../../../../../src/components/context/contextManager.js');
jest.mock('../../../../../src/components/llm/geminiClient.js');
jest.mock('../../../../../src/components/llm/geminiImageClient.js');
jest.mock('../../../../../src/components/llm/llmUtils.js');
jest.mock('../../../../../src/components/twitch/streamImageCapture.js');
jest.mock('../../../../../src/components/twitch/streamInfoPoller.js');
jest.mock('../../../../../src/lib/logger.js');
jest.mock('../../../../../src/lib/ircSender.js');

import gameHandler from '../../../../../src/components/commands/handlers/game.js';
import { getContextManager } from '../../../../../src/components/context/contextManager.js';
import {
    buildContextPrompt,
    generateSearchResponse,
    generateStandardResponse,
    summarizeText
} from '../../../../../src/components/llm/geminiClient.js';
import { analyzeImage } from '../../../../../src/components/llm/geminiImageClient.js';
import { removeMarkdownAsterisks } from '../../../../../src/components/llm/llmUtils.js';
import { fetchStreamThumbnail } from '../../../../../src/components/twitch/streamImageCapture.js';
import { getCurrentGameInfo } from '../../../../../src/components/twitch/streamInfoPoller.js';
import { enqueueMessage } from '../../../../../src/lib/ircSender.js';

describe('Game Command Handler', () => {
    let mockContextManager;

    const createMockContext = (args = [], channel = '#testchannel', user = { username: 'testuser', 'display-name': 'TestUser', id: '123' }) => ({
        channel,
        user,
        args,
        message: `!game ${args.join(' ')}`,
        ircClient: {},
        contextManager: mockContextManager
    });

    beforeEach(() => {
        // Clear mocks (except logger which is mocked at module level)
        getContextManager.mockClear();
        buildContextPrompt.mockClear();
        generateSearchResponse.mockClear();
        generateStandardResponse.mockClear();
        summarizeText.mockClear();
        analyzeImage.mockClear();
        removeMarkdownAsterisks.mockClear();
        fetchStreamThumbnail.mockClear();
        getCurrentGameInfo.mockClear();
        enqueueMessage.mockClear();

        // Setup mocks
        mockContextManager = {
            getContextForLLM: jest.fn(),
            getGameFromContext: jest.fn()
        };

        // Mock the imported functions
        getContextManager.mockReturnValue(mockContextManager);
        buildContextPrompt.mockReturnValue('mock context prompt');
        generateSearchResponse.mockResolvedValue('mock search response');
        generateStandardResponse.mockResolvedValue('mock standard response');
        summarizeText.mockResolvedValue('summarized text');
        analyzeImage.mockResolvedValue('mock image analysis');
        removeMarkdownAsterisks.mockImplementation((text) => text?.replace(/\*\*([^\*]+)\*\*/g, '$1').replace(/\*([^\*]+)\*/g, '$1') || '');
        fetchStreamThumbnail.mockResolvedValue(Buffer.from('fake image'));
        getCurrentGameInfo.mockResolvedValue({ gameName: 'Test Game', gameId: '12345' });
        enqueueMessage.mockResolvedValue();

        // Setup context manager default return
        mockContextManager.getContextForLLM.mockReturnValue({
            channel: 'testchannel',
            currentGame: 'Test Game',
            chatHistory: []
        });
        mockContextManager.getGameFromContext.mockReturnValue({ gameName: 'Test Game', gameId: '12345' });
    });

    describe('Command Info', () => {
        test('should have correct command metadata', () => {
            expect(gameHandler.name).toBe('game');
            expect(gameHandler.description).toContain('Provides information about the game');
            expect(gameHandler.usage).toBe('!game [analyze] [your question]');
            expect(gameHandler.permission).toBe('everyone');
        });
    });

    describe('Markdown Removal - Basic Game Info', () => {
        test('should remove asterisk markdown from game info response', async () => {
            generateSearchResponse.mockResolvedValue('**Dark Souls** is a challenging *action RPG*');

            const context = createMockContext([]);
            await gameHandler.execute(context);

            expect(removeMarkdownAsterisks).toHaveBeenCalledWith('**Dark Souls** is a challenging *action RPG*');
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Dark Souls is a challenging action RPG',
                { replyToId: '123' }
            );
        });

        test('should remove markdown from truncated game info', async () => {
            const longText = 'a'.repeat(500) + ' **title** and *emphasis*';
            generateSearchResponse.mockResolvedValue(longText);
            summarizeText.mockResolvedValue(null); // Force truncation path

            const context = createMockContext([]);
            await gameHandler.execute(context);

            // Should call markdown removal on truncated text
            expect(removeMarkdownAsterisks).toHaveBeenCalled();
            const calls = removeMarkdownAsterisks.mock.calls;
            expect(calls.some(call => call[0]?.includes('...'))).toBe(true);
        });

        test('should handle responses without markdown', async () => {
            generateSearchResponse.mockResolvedValue('Plain game description');

            const context = createMockContext([]);
            await gameHandler.execute(context);

            expect(removeMarkdownAsterisks).toHaveBeenCalledWith('Plain game description');
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Plain game description',
                { replyToId: '123' }
            );
        });
    });

    describe('Markdown Removal - Help Query', () => {
        test('should remove markdown from help query search response', async () => {
            generateSearchResponse.mockResolvedValue('Try using **dodge roll** to avoid *enemy attacks*');

            const context = createMockContext(['how', 'to', 'dodge']);
            await gameHandler.execute(context);

            expect(removeMarkdownAsterisks).toHaveBeenCalledWith('Try using **dodge roll** to avoid *enemy attacks*');
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Try using dodge roll to avoid enemy attacks',
                { replyToId: '123' }
            );
        });

        test('should remove markdown from summarized help response', async () => {
            const longResponse = 'a'.repeat(500);
            generateSearchResponse.mockResolvedValue(longResponse);
            summarizeText.mockResolvedValue('**Summary** with *markdown*');

            const context = createMockContext(['tips']);
            await gameHandler.execute(context);

            expect(removeMarkdownAsterisks).toHaveBeenCalledWith('**Summary** with *markdown*');
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Summary with markdown',
                { replyToId: '123' }
            );
        });

        test('should handle multiple titles in help response', async () => {
            generateSearchResponse.mockResolvedValue('Use **Fire** or *Lightning* against **boss**');

            const context = createMockContext(['boss', 'strategy']);
            await gameHandler.execute(context);

            expect(removeMarkdownAsterisks).toHaveBeenCalled();
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Use Fire or Lightning against boss',
                { replyToId: '123' }
            );
        });
    });

    describe('Markdown Removal - Image Analysis', () => {
        test('should remove markdown from image analysis description', async () => {
            analyzeImage.mockResolvedValue('Player fighting **Dragon** in *cave*');
            generateSearchResponse.mockResolvedValue('This is a **boss fight** scene');

            const context = createMockContext(['analyze']);
            await gameHandler.execute(context);

            expect(removeMarkdownAsterisks).toHaveBeenCalled();
            // Should remove markdown from the analyzed description
            const calls = removeMarkdownAsterisks.mock.calls;
            expect(calls.some(call => call[0]?.includes('Player fighting'))).toBe(false); // Already stripped
        });

        test('should remove markdown from summarized analysis', async () => {
            const longAnalysis = 'a'.repeat(500);
            analyzeImage.mockResolvedValue(longAnalysis);
            generateSearchResponse.mockResolvedValue(longAnalysis);
            summarizeText.mockResolvedValue('**Summarized** *analysis*');

            const context = createMockContext(['analyze']);
            await gameHandler.execute(context);

            expect(removeMarkdownAsterisks).toHaveBeenCalledWith('**Summarized** *analysis*');
        });
    });

    describe('Basic Game Info Flow', () => {
        test('should fetch and display game info when no args provided', async () => {
            generateSearchResponse.mockResolvedValue('Interesting game fact');

            const context = createMockContext([]);
            await gameHandler.execute(context);

            expect(generateSearchResponse).toHaveBeenCalled();
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Interesting game fact',
                { replyToId: '123' }
            );
        });

        test('should fallback to standard response if search fails', async () => {
            generateSearchResponse.mockResolvedValue(null);
            generateStandardResponse.mockResolvedValue('Standard game info');

            const context = createMockContext([]);
            await gameHandler.execute(context);

            expect(generateSearchResponse).toHaveBeenCalled();
            expect(generateStandardResponse).toHaveBeenCalled();
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Standard game info',
                { replyToId: '123' }
            );
        });

        test('should handle unknown game gracefully', async () => {
            mockContextManager.getGameFromContext.mockReturnValue(null);
            getCurrentGameInfo.mockResolvedValue(null);
            generateSearchResponse.mockResolvedValue(null);
            generateStandardResponse.mockResolvedValue(null);

            const context = createMockContext([]);
            await gameHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                "I don't see a game set for the stream right now.",
                { replyToId: '123' }
            );
        });
    });

    describe('Help Query Flow', () => {
        test('should process help query with game context', async () => {
            generateSearchResponse.mockResolvedValue('Help response');

            const context = createMockContext(['how', 'to', 'beat', 'boss']);
            await gameHandler.execute(context);

            expect(generateSearchResponse).toHaveBeenCalled();
            const callArgs = generateSearchResponse.mock.calls[0];
            expect(callArgs[1]).toContain('how to beat boss');
            expect(callArgs[1]).toContain('Test Game');
        });

        test('should summarize long help responses', async () => {
            const longResponse = 'a'.repeat(500);
            generateSearchResponse.mockResolvedValue(longResponse);
            summarizeText.mockResolvedValue('Short summary');

            const context = createMockContext(['tips']);
            await gameHandler.execute(context);

            expect(summarizeText).toHaveBeenCalled();
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Short summary',
                { replyToId: '123' }
            );
        });
    });

    describe('Image Analysis Flow', () => {
        test('should analyze stream thumbnail when analyze keyword used', async () => {
            analyzeImage.mockResolvedValue('Screenshot shows gameplay');
            generateSearchResponse.mockResolvedValue('Refined description');

            const context = createMockContext(['analyze']);
            await gameHandler.execute(context);

            expect(fetchStreamThumbnail).toHaveBeenCalledWith('testchannel');
            expect(analyzeImage).toHaveBeenCalled();
            expect(generateSearchResponse).toHaveBeenCalled();
        });

        test('should handle failed thumbnail fetch', async () => {
            fetchStreamThumbnail.mockResolvedValue(null);

            const context = createMockContext(['analyze']);
            await gameHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                "Couldn't fetch the stream thumbnail. The channel might be offline.",
                { replyToId: '123' }
            );
            expect(analyzeImage).not.toHaveBeenCalled();
        });

        test('should handle analyze with additional query', async () => {
            analyzeImage.mockResolvedValue('Boss fight scene');
            generateSearchResponse.mockResolvedValue('Refined description');

            const context = createMockContext(['analyze', 'what', 'boss']);
            await gameHandler.execute(context);

            expect(fetchStreamThumbnail).toHaveBeenCalled();
            expect(analyzeImage).toHaveBeenCalled();
        });
    });

    describe('Error Handling', () => {
        test('should handle LLM errors gracefully', async () => {
            generateSearchResponse.mockRejectedValue(new Error('LLM error'));
            generateStandardResponse.mockRejectedValue(new Error('LLM error'));

            const context = createMockContext([]);
            await gameHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Currently playing Test Game. Try "!game [your question]" for specific help with the game.',
                { replyToId: '123' }
            );
        });

        test('should handle image analysis errors', async () => {
            analyzeImage.mockRejectedValue(new Error('Analysis failed'));

            const context = createMockContext(['analyze']);
            await gameHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Sorry, there was an error analyzing the stream.',
                { replyToId: '123' }
            );
        });

        test('should handle empty search and standard responses', async () => {
            generateSearchResponse.mockResolvedValue('');
            generateStandardResponse.mockResolvedValue('');

            const context = createMockContext([]);
            await gameHandler.execute(context);

            // Should send basic game name fallback
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.stringContaining('Test Game'),
                { replyToId: '123' }
            );
        });
    });

    describe('Reply ID Handling', () => {
        test('should use user.id for replyToId', async () => {
            generateSearchResponse.mockResolvedValue('Game info');

            const context = createMockContext([], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '12345'
            });
            await gameHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.any(String),
                { replyToId: '12345' }
            );
        });

        test('should fallback to message-id if user.id not available', async () => {
            generateSearchResponse.mockResolvedValue('Game info');

            const context = createMockContext([], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                'message-id': 'msg-123'
            });
            await gameHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.any(String),
                { replyToId: 'msg-123' }
            );
        });

        test('should use null if no replyToId available', async () => {
            generateSearchResponse.mockResolvedValue('Game info');

            const context = createMockContext([], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser'
            });
            await gameHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.any(String),
                { replyToId: null }
            );
        });
    });

    describe('Summarization Path', () => {
        test('should summarize when response exceeds length limit', async () => {
            const longText = 'a'.repeat(500);
            generateSearchResponse.mockResolvedValue(longText);
            summarizeText.mockResolvedValue('Short version');

            const context = createMockContext(['question']);
            await gameHandler.execute(context);

            expect(summarizeText).toHaveBeenCalled();
            expect(removeMarkdownAsterisks).toHaveBeenCalledWith('Short version');
        });

        test('should truncate when summarization fails', async () => {
            const longText = 'a'.repeat(500);
            generateSearchResponse.mockResolvedValue(longText);
            summarizeText.mockResolvedValue(null);

            const context = createMockContext(['question']);
            await gameHandler.execute(context);

            // Should truncate and add ellipsis
            const call = enqueueMessage.mock.calls[0];
            expect(call[1]).toMatch(/\.\.\.$/);
        });
    });

    describe('Meta Thought Scrubbing', () => {
        test('should remove meta thought prefixes from responses', async () => {
            generateSearchResponse.mockResolvedValue('Thinking Process: Some analysis. Actual answer here.');

            const context = createMockContext([]);
            await gameHandler.execute(context);

            const call = enqueueMessage.mock.calls[0];
            expect(call[1]).not.toContain('Thinking Process');
        });

        test('should handle responses with reasoning prefix', async () => {
            generateSearchResponse.mockResolvedValue('Reasoning: First analyze. Then conclude.');

            const context = createMockContext([]);
            await gameHandler.execute(context);

            const call = enqueueMessage.mock.calls[0];
            expect(call[1]).not.toContain('Reasoning:');
        });
    });
});

