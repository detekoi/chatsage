// tests/unit/components/context/summarizer.test.js

jest.mock('../../../../src/lib/logger.js');

import logger from '../../../../src/lib/logger.js';
import { triggerSummarizationIfNeeded } from '../../../../src/components/context/summarizer.js';

// Mock the geminiClient
jest.mock('../../../../src/components/llm/geminiClient.js', () => ({
    summarizeText: jest.fn()
}));

import { summarizeText } from '../../../../src/components/llm/geminiClient.js';

describe('summarizer.triggerSummarizationIfNeeded', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should return null for short chat history segments', async () => {
        const shortHistory = [
            { username: 'user1', message: 'Hello' },
            { username: 'user2', message: 'Hi there' }
        ];

        const result = await triggerSummarizationIfNeeded('testchannel', shortHistory);

        expect(result).toBeNull();
        expect(summarizeText).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith(
            '[testchannel] History segment too short, skipping summarization.'
        );
    });

    it('should return null when history is null or undefined', async () => {
        const result1 = await triggerSummarizationIfNeeded('testchannel', null);
        expect(result1).toBeNull();

        const result2 = await triggerSummarizationIfNeeded('testchannel', undefined);
        expect(result2).toBeNull();

        expect(summarizeText).not.toHaveBeenCalled();
    });

    it('should return null for empty history array', async () => {
        const result = await triggerSummarizationIfNeeded('testchannel', []);
        expect(result).toBeNull();
        expect(summarizeText).not.toHaveBeenCalled();
    });

    it('should summarize single chunk of messages successfully', async () => {
        const chatHistory = Array.from({ length: 15 }, (_, i) => ({
            username: `user${i}`,
            message: `Message ${i}`
        }));

        const mockSummary = 'This is a summary of the chat history.';
        summarizeText.mockResolvedValue(mockSummary);

        const result = await triggerSummarizationIfNeeded('testchannel', chatHistory);

        expect(result).toBe(mockSummary);
        expect(summarizeText).toHaveBeenCalledTimes(1);

        // Verify the formatted history was passed correctly
        const callArgs = summarizeText.mock.calls[0];
        expect(callArgs[0]).toContain('user0: Message 0');
        expect(callArgs[0]).toContain('user14: Message 14');
        expect(callArgs[1]).toBe(450); // reduceTargetChars

        expect(logger.info).toHaveBeenCalledWith(
            expect.stringMatching(/\[testchannel\] Single-pass summary generated \(\d+ chars\)\./)
        );
    });

    it('should handle map/reduce summarization for larger history segments', async () => {
        // Create a history larger than chunkSize (20)
        const chatHistory = Array.from({ length: 45 }, (_, i) => ({
            username: `user${i}`,
            message: `Message ${i}`
        }));

        const chunkSummaries = [
            'Chunk 1 summary',
            'Chunk 2 summary',
            'Chunk 3 summary'
        ];
        const finalSummary = 'Final combined summary';

        // Mock chunk summaries
        summarizeText
            .mockResolvedValueOnce(chunkSummaries[0]) // First chunk
            .mockResolvedValueOnce(chunkSummaries[1]) // Second chunk
            .mockResolvedValueOnce(chunkSummaries[2]) // Third chunk
            .mockResolvedValueOnce(finalSummary); // Final reduce step

        const result = await triggerSummarizationIfNeeded('testchannel', chatHistory);

        expect(result).toBe(finalSummary);
        expect(summarizeText).toHaveBeenCalledTimes(4); // 3 chunks + 1 reduce

        // Verify chunk summaries were called with correct parameters
        expect(summarizeText).toHaveBeenNthCalledWith(1,
            expect.stringContaining('Segment 1 of 3'),
            220 // mapTargetChars
        );
        expect(summarizeText).toHaveBeenNthCalledWith(4,
            expect.stringContaining('Combine these chunk summaries'),
            450 // reduceTargetChars
        );

        expect(logger.info).toHaveBeenCalledWith(
            expect.stringMatching(/\[testchannel\] Map\/Reduce summary generated \(\d+ chars\) from 3 chunk summaries\./)
        );
    });

    it('should handle partial chunk summary failures in map/reduce', async () => {
        const chatHistory = Array.from({ length: 45 }, (_, i) => ({
            username: `user${i}`,
            message: `Message ${i}`
        }));

        const finalSummary = 'Final summary from successful chunks';

        // First chunk fails, second succeeds, third fails
        summarizeText
            .mockResolvedValueOnce('') // First chunk fails (empty)
            .mockResolvedValueOnce('Valid chunk summary') // Second chunk succeeds
            .mockResolvedValueOnce('') // Third chunk fails (empty)
            .mockResolvedValueOnce(finalSummary); // Final reduce step

        const result = await triggerSummarizationIfNeeded('testchannel', chatHistory);

        expect(result).toBe(finalSummary);
        expect(summarizeText).toHaveBeenCalledTimes(4);

        expect(logger.info).toHaveBeenCalledWith(
            expect.stringMatching(/\[testchannel\] Map\/Reduce summary generated \(\d+ chars\) from 1 chunk summaries\./)
        );
    });

    it('should return null when all chunk summaries fail', async () => {
        const chatHistory = Array.from({ length: 45 }, (_, i) => ({
            username: `user${i}`,
            message: `Message ${i}`
        }));

        // All chunk summaries fail (empty strings)
        summarizeText
            .mockResolvedValueOnce('') // First chunk
            .mockResolvedValueOnce('') // Second chunk
            .mockResolvedValueOnce(''); // Third chunk

        const result = await triggerSummarizationIfNeeded('testchannel', chatHistory);

        expect(result).toBeNull();
        expect(summarizeText).toHaveBeenCalledTimes(3); // Only chunks, no reduce step

        expect(logger.warn).toHaveBeenCalledWith(
            '[testchannel] All chunk summaries were empty.'
        );
    });

    it('should handle errors during single-pass summarization', async () => {
        const chatHistory = Array.from({ length: 15 }, (_, i) => ({
            username: `user${i}`,
            message: `Message ${i}`
        }));

        summarizeText.mockRejectedValue(new Error('API Error'));

        const result = await triggerSummarizationIfNeeded('testchannel', chatHistory);

        expect(result).toBeNull();
        expect(summarizeText).toHaveBeenCalledTimes(1);

        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                err: expect.any(Error),
                channel: 'testchannel'
            }),
            'Error during single-pass summarization API call.'
        );
    });

    it('should handle errors during map step', async () => {
        const chatHistory = Array.from({ length: 45 }, (_, i) => ({
            username: `user${i}`,
            message: `Message ${i}`
        }));

        summarizeText.mockRejectedValue(new Error('API Error'));

        const result = await triggerSummarizationIfNeeded('testchannel', chatHistory);

        expect(result).toBeNull();
        expect(summarizeText).toHaveBeenCalledTimes(3); // All chunks are attempted

        // The implementation logs individual chunk errors, but doesn't log an overall failure
        // since each promise rejection is handled individually
    });

    it('should handle errors during reduce step', async () => {
        const chatHistory = Array.from({ length: 45 }, (_, i) => ({
            username: `user${i}`,
            message: `Message ${i}`
        }));

        const validSummary = 'Valid chunk summary';

        summarizeText
            .mockResolvedValueOnce(validSummary) // First chunk succeeds
            .mockResolvedValueOnce(validSummary) // Second chunk succeeds
            .mockRejectedValueOnce(new Error('Reduce API Error')); // Reduce step fails

        const result = await triggerSummarizationIfNeeded('testchannel', chatHistory);

        expect(result).toBeNull();
        expect(summarizeText).toHaveBeenCalledTimes(4); // 3 chunks + 1 failed reduce

        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                err: expect.any(Error),
                channel: 'testchannel'
            }),
            'Error during reduce summarization API call.'
        );
    });

    it('should handle empty summary result after trimming', async () => {
        const chatHistory = Array.from({ length: 15 }, (_, i) => ({
            username: `user${i}`,
            message: `Message ${i}`
        }));

        summarizeText.mockResolvedValue('   '); // Whitespace only

        const result = await triggerSummarizationIfNeeded('testchannel', chatHistory);

        expect(result).toBeNull();
        expect(summarizeText).toHaveBeenCalledTimes(1);

        expect(logger.warn).toHaveBeenCalledWith(
            '[testchannel] Summarization returned empty result for single chunk.'
        );
    });

    // --- previousSummary folding tests ---

    describe('previousSummary folding', () => {
        it('should fold previousSummary into single-chunk summarization prompt', async () => {
            const chatHistory = Array.from({ length: 15 }, (_, i) => ({
                username: `user${i}`,
                message: `Message ${i}`
            }));

            const previousSummary = 'Earlier the chat discussed cats and dogs.';
            const mockSummary = 'Combined summary with old + new context.';
            summarizeText.mockResolvedValue(mockSummary);

            const result = await triggerSummarizationIfNeeded('testchannel', chatHistory, previousSummary);

            expect(result).toBe(mockSummary);
            expect(summarizeText).toHaveBeenCalledTimes(1);

            // Verify the prompt includes the previous summary
            const prompt = summarizeText.mock.calls[0][0];
            expect(prompt).toContain('Previous context summary:');
            expect(prompt).toContain(previousSummary);
            expect(prompt).toContain('New chat messages to incorporate:');
            expect(prompt).toContain('user0: Message 0');
        });

        it('should fold previousSummary into map/reduce reduce step', async () => {
            const chatHistory = Array.from({ length: 45 }, (_, i) => ({
                username: `user${i}`,
                message: `Message ${i}`
            }));

            const previousSummary = 'Earlier the chat discussed cats and dogs.';
            const finalSummary = 'Comprehensive folded summary.';

            summarizeText
                .mockResolvedValueOnce('Chunk 1 summary')
                .mockResolvedValueOnce('Chunk 2 summary')
                .mockResolvedValueOnce('Chunk 3 summary')
                .mockResolvedValueOnce(finalSummary);

            const result = await triggerSummarizationIfNeeded('testchannel', chatHistory, previousSummary);

            expect(result).toBe(finalSummary);

            // Verify the reduce step (4th call) includes the previous summary
            const reducePrompt = summarizeText.mock.calls[3][0];
            expect(reducePrompt).toContain('Previous context summary:');
            expect(reducePrompt).toContain(previousSummary);
            expect(reducePrompt).toContain('New chunk summaries to incorporate:');
            expect(reducePrompt).toContain('Chunk 1:');

            // Map step prompts (calls 0-2) should NOT contain the previous summary
            for (let i = 0; i < 3; i++) {
                expect(summarizeText.mock.calls[i][0]).not.toContain('Previous context summary:');
            }
        });

        it('should handle null previousSummary (state.chatSummary can be null)', async () => {
            const chatHistory = Array.from({ length: 15 }, (_, i) => ({
                username: `user${i}`,
                message: `Message ${i}`
            }));

            const mockSummary = 'Summary without prior context.';
            summarizeText.mockResolvedValue(mockSummary);

            // Explicitly pass null — this is the real-world case from state.chatSummary
            const result = await triggerSummarizationIfNeeded('testchannel', chatHistory, null);

            expect(result).toBe(mockSummary);

            // Prompt should NOT include "Previous context summary:" when null
            const prompt = summarizeText.mock.calls[0][0];
            expect(prompt).not.toContain('Previous context summary:');
            expect(prompt).toContain('user0: Message 0');
        });

        it('should handle omitted previousSummary (undefined)', async () => {
            const chatHistory = Array.from({ length: 15 }, (_, i) => ({
                username: `user${i}`,
                message: `Message ${i}`
            }));

            const mockSummary = 'Summary without prior context.';
            summarizeText.mockResolvedValue(mockSummary);

            // Omit the 3rd argument entirely
            const result = await triggerSummarizationIfNeeded('testchannel', chatHistory);

            expect(result).toBe(mockSummary);

            // Prompt should NOT include "Previous context summary:" when omitted
            const prompt = summarizeText.mock.calls[0][0];
            expect(prompt).not.toContain('Previous context summary:');
        });

        it('should handle empty string previousSummary', async () => {
            const chatHistory = Array.from({ length: 15 }, (_, i) => ({
                username: `user${i}`,
                message: `Message ${i}`
            }));

            const mockSummary = 'Summary without prior context.';
            summarizeText.mockResolvedValue(mockSummary);

            const result = await triggerSummarizationIfNeeded('testchannel', chatHistory, '');

            expect(result).toBe(mockSummary);

            // Empty string is falsy — should NOT include "Previous context summary:"
            const prompt = summarizeText.mock.calls[0][0];
            expect(prompt).not.toContain('Previous context summary:');
        });

        it('should handle whitespace-only previousSummary', async () => {
            const chatHistory = Array.from({ length: 15 }, (_, i) => ({
                username: `user${i}`,
                message: `Message ${i}`
            }));

            const mockSummary = 'Summary without prior context.';
            summarizeText.mockResolvedValue(mockSummary);

            const result = await triggerSummarizationIfNeeded('testchannel', chatHistory, '   ');

            expect(result).toBe(mockSummary);

            // Whitespace-only trims to empty string — should NOT include previous summary
            const prompt = summarizeText.mock.calls[0][0];
            expect(prompt).not.toContain('Previous context summary:');
        });

        it('should log when folding previous summary', async () => {
            const chatHistory = Array.from({ length: 15 }, (_, i) => ({
                username: `user${i}`,
                message: `Message ${i}`
            }));

            summarizeText.mockResolvedValue('Summary');

            await triggerSummarizationIfNeeded('testchannel', chatHistory, 'Old summary');

            expect(logger.info).toHaveBeenCalledWith(
                expect.stringContaining('(folding previous summary)')
            );
        });

        it('should not log folding when no previous summary', async () => {
            const chatHistory = Array.from({ length: 15 }, (_, i) => ({
                username: `user${i}`,
                message: `Message ${i}`
            }));

            summarizeText.mockResolvedValue('Summary');

            await triggerSummarizationIfNeeded('testchannel', chatHistory);

            expect(logger.info).toHaveBeenCalledWith(
                expect.not.stringContaining('(folding previous summary)')
            );
        });
    });
});
