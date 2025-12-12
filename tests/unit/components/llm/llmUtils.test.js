// tests/unit/components/llm/llmUtils.test.js

jest.mock('../../../../src/lib/logger.js');
jest.mock('../../../../src/components/context/contextManager.js');
jest.mock('../../../../src/components/llm/geminiClient.js');
jest.mock('../../../../src/components/llm/botResponseHandler.js');

import {
    removeMarkdownAsterisks,
    handleStandardLlmQuery
} from '../../../../src/components/llm/llmUtils.js';
import logger from '../../../../src/lib/logger.js';
import { getContextManager } from '../../../../src/components/context/contextManager.js';
import {
    buildContextPrompt,
    summarizeText,
    getOrCreateChatSession
} from '../../../../src/components/llm/geminiClient.js';
import { sendBotResponse } from '../../../../src/components/llm/botResponseHandler.js';

describe('llmUtils', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        // Mock the dependencies
        const mockChannelState = new Map([
            ['testchannel', {
                chatHistory: []
            }]
        ]);

        getContextManager.mockReturnValue({
            getContextForLLM: jest.fn().mockReturnValue({
                chatHistory: [],
                streamContext: {},
                userStates: new Map(),
                botLanguage: 'en'
            }),
            getAllChannelStates: jest.fn().mockReturnValue(mockChannelState)
        });

        buildContextPrompt.mockReturnValue('Mock context prompt');
        getOrCreateChatSession.mockReturnValue({
            sendMessage: jest.fn().mockResolvedValue({
                text: jest.fn().mockReturnValue('Mock LLM response'),
                candidates: [{
                    content: { parts: [{ text: 'Mock LLM response' }] }
                }]
            })
        });

        sendBotResponse.mockResolvedValue();
    });

    describe('removeMarkdownAsterisks', () => {
        it('should remove bold markdown', () => {
            const result = removeMarkdownAsterisks('**bold text**');

            expect(result).toBe('bold text');
        });

        it('should remove italic markdown', () => {
            const result = removeMarkdownAsterisks('*italic text*');

            expect(result).toBe('italic text');
        });

        it('should remove nested markdown', () => {
            const result = removeMarkdownAsterisks('***bold italic***');

            expect(result).toBe('bold italic');
        });

        it('should handle mixed text with markdown', () => {
            const result = removeMarkdownAsterisks('Hello **world**!');

            expect(result).toBe('Hello world!');
        });

        it('should handle multiple markdown instances', () => {
            const result = removeMarkdownAsterisks('**First** and *second*');

            expect(result).toBe('First and second');
        });

        it('should handle titles with asterisk markdown', () => {
            const result = removeMarkdownAsterisks('The movie **Inception** is great');

            expect(result).toBe('The movie Inception is great');
        });

        it('should return unchanged text when no markdown', () => {
            const result = removeMarkdownAsterisks('Plain text');

            expect(result).toBe('Plain text');
        });

        it('should handle empty string', () => {
            const result = removeMarkdownAsterisks('');

            expect(result).toBe('');
        });

        it('should handle null input', () => {
            const result = removeMarkdownAsterisks(null);

            expect(result).toBe('');
        });

        it('should handle undefined input', () => {
            const result = removeMarkdownAsterisks(undefined);

            expect(result).toBe('');
        });
    });

    describe('handleStandardLlmQuery', () => {
        it('should handle successful LLM query', async () => {
            await handleStandardLlmQuery('#testchannel', 'testchannel', 'TestUser', 'testuser', 'Hello bot');

            expect(getContextManager).toHaveBeenCalled();
            expect(buildContextPrompt).toHaveBeenCalled();
            expect(getOrCreateChatSession).toHaveBeenCalledWith('testchannel', 'Mock context prompt', expect.anything());
            expect(sendBotResponse).toHaveBeenCalledWith('#testchannel', 'Mock LLM response', { replyToId: null });
            expect(logger.info).toHaveBeenCalledWith(
                { channel: 'testchannel', user: 'testuser', trigger: 'mention' },
                'Handling standard LLM query.'
            );
        });

        it('should handle query with replyToId', async () => {
            await handleStandardLlmQuery('#testchannel', 'testchannel', 'TestUser', 'testuser', 'Hello bot', 'mention', 'reply-id-123');

            expect(sendBotResponse).toHaveBeenCalledWith('#testchannel', 'Mock LLM response', { replyToId: 'reply-id-123' });
        });

        it('should handle query with command trigger', async () => {
            await handleStandardLlmQuery('#testchannel', 'testchannel', 'TestUser', 'testuser', 'Hello bot', 'command');

            expect(logger.info).toHaveBeenCalledWith(
                { channel: 'testchannel', user: 'testuser', trigger: 'command' },
                'Handling standard LLM query.'
            );
        });

        it('should return early when context is not available', async () => {
            getContextManager.mockReturnValue({
                getContextForLLM: jest.fn().mockReturnValue(null)
            });

            await handleStandardLlmQuery('#testchannel', 'testchannel', 'TestUser', 'testuser', 'Hello bot');

            expect(logger.warn).toHaveBeenCalledWith(
                { channel: 'testchannel', user: 'testuser', trigger: 'mention' },
                'Could not retrieve context for LLM response.'
            );
            expect(sendBotResponse).not.toHaveBeenCalled();
        });

        it('should handle empty LLM response', async () => {
            getOrCreateChatSession.mockReturnValue({
                sendMessage: jest.fn().mockResolvedValue({
                    text: jest.fn().mockReturnValue(''),
                    candidates: []
                })
            });

            await handleStandardLlmQuery('#testchannel', 'testchannel', 'TestUser', 'testuser', 'Hello bot');

            expect(sendBotResponse).toHaveBeenCalledWith('#testchannel', "I'm a bit stumped on that one! Try asking another way?", { replyToId: null });
            expect(logger.error).toHaveBeenCalledWith(
                '[testchannel] LLM generated null or empty response after retry. Sending fallback.'
            );
        });

        it('should handle null LLM response', async () => {
            getOrCreateChatSession.mockReturnValue({
                sendMessage: jest.fn().mockResolvedValue({
                    text: jest.fn().mockReturnValue(null),
                    candidates: []
                })
            });

            await handleStandardLlmQuery('#testchannel', 'testchannel', 'TestUser', 'testuser', 'Hello bot');

            expect(sendBotResponse).toHaveBeenCalledWith('#testchannel', "I'm a bit stumped on that one! Try asking another way?", { replyToId: null });
        });

        it('should handle long responses with summarization', async () => {
            const longResponse = 'A'.repeat(600); // Longer than MAX_IRC_MESSAGE_LENGTH (500)

            getOrCreateChatSession.mockReturnValue({
                sendMessage: jest.fn().mockResolvedValue({
                    text: jest.fn().mockReturnValue(longResponse),
                    candidates: [{
                        content: { parts: [{ text: longResponse }] }
                    }]
                })
            });

            summarizeText.mockResolvedValue('Short summary');

            await handleStandardLlmQuery('#testchannel', 'testchannel', 'TestUser', 'testuser', 'Hello bot');

            expect(summarizeText).toHaveBeenCalledWith(longResponse, 400);
            expect(sendBotResponse).toHaveBeenCalledWith('#testchannel', 'Short summary', { replyToId: null });
            expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/Summarization successful \(\d+ chars\)\./));
        });

        it('should handle summarization failure', async () => {
            const longResponse = 'A'.repeat(600);

            getOrCreateChatSession.mockReturnValue({
                sendMessage: jest.fn().mockResolvedValue({
                    text: jest.fn().mockReturnValue(longResponse),
                    candidates: [{
                        content: { parts: [{ text: longResponse }] }
                    }]
                })
            });

            summarizeText.mockResolvedValue(''); // Empty summary

            await handleStandardLlmQuery('#testchannel', 'testchannel', 'TestUser', 'testuser', 'Hello bot');

            expect(sendBotResponse).toHaveBeenCalledWith('#testchannel', 'A'.repeat(499) + '.', { replyToId: null });
            expect(logger.warn).toHaveBeenCalledWith('Summarization failed or returned empty for mention response. Falling back to smart truncation.');
        });

        it('should handle responses that are too long even after summarization', async () => {
            const longResponse = 'A'.repeat(600);

            getOrCreateChatSession.mockReturnValue({
                sendMessage: jest.fn().mockResolvedValue({
                    text: jest.fn().mockReturnValue(longResponse),
                    candidates: [{
                        content: { parts: [{ text: longResponse }] }
                    }]
                })
            });

            summarizeText.mockResolvedValue('B'.repeat(600)); // Summary still too long

            await handleStandardLlmQuery('#testchannel', 'testchannel', 'TestUser', 'testuser', 'Hello bot');

            expect(sendBotResponse).toHaveBeenCalledWith('#testchannel', 'B'.repeat(499) + '.', { replyToId: null });
            expect(logger.warn).toHaveBeenCalledWith('Final reply (even after summary/truncation) too long (600 chars). Applying smart truncation.');
        });

        it('should handle LLM errors gracefully', async () => {
            getOrCreateChatSession.mockReturnValue({
                sendMessage: jest.fn().mockRejectedValue(new Error('LLM API Error'))
            });

            await handleStandardLlmQuery('#testchannel', 'testchannel', 'TestUser', 'testuser', 'Hello bot');

            expect(sendBotResponse).toHaveBeenCalledWith('#testchannel', 'Sorry, an error occurred while processing that.', { replyToId: null });
            expect(logger.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    err: expect.any(Error),
                    channel: 'testchannel',
                    user: 'testuser',
                    trigger: 'mention'
                }),
                'Error processing standard LLM query.'
            );
        });

        it('should handle error message sending failures', async () => {
            getOrCreateChatSession.mockReturnValue({
                sendMessage: jest.fn().mockRejectedValue(new Error('LLM API Error'))
            });

            sendBotResponse.mockRejectedValue(new Error('Failed to send error message'));

            await handleStandardLlmQuery('#testchannel', 'testchannel', 'TestUser', 'testuser', 'Hello bot');

            expect(logger.error).toHaveBeenCalledWith(
                { err: expect.any(Error) },
                'Failed to send LLM error message to chat.'
            );
        });

        it('should log search grounding metadata when available', async () => {
            const mockChatResult = {
                candidates: [{
                    groundingMetadata: {
                        webSearchQueries: ['test query'],
                        groundingChunks: [
                            { web: { uri: 'https://example.com' } },
                            { web: { uri: 'https://test.com' } }
                        ]
                    },
                    citationMetadata: {
                        citationSources: [{ title: 'Test Source' }]
                    }
                }],
                text: jest.fn().mockReturnValue('Response with grounding')
            };

            getOrCreateChatSession.mockReturnValue({
                sendMessage: jest.fn().mockResolvedValue(mockChatResult)
            });

            await handleStandardLlmQuery('#testchannel', 'testchannel', 'TestUser', 'testuser', 'Hello bot');

            expect(logger.info).toHaveBeenCalledWith(
                { usedGoogleSearch: true, webSearchQueries: ['test query'], sources: ['https://example.com', 'https://test.com'] },
                '[StandardChat] Search grounding metadata.'
            );
            expect(logger.info).toHaveBeenCalledWith(
                { citations: [{ title: 'Test Source' }] },
                '[StandardChat] Response included citations.'
            );
        });

        it('should handle missing grounding metadata gracefully', async () => {
            const mockChatResult = {
                candidates: [{}],
                text: jest.fn().mockReturnValue('Response without grounding')
            };

            getOrCreateChatSession.mockReturnValue({
                sendMessage: jest.fn().mockResolvedValue(mockChatResult)
            });

            await handleStandardLlmQuery('#testchannel', 'testchannel', 'TestUser', 'testuser', 'Hello bot');

            expect(logger.info).toHaveBeenCalledWith(
                { usedGoogleSearch: false },
                '[StandardChat] No search grounding metadata present.'
            );
        });
    });
});
