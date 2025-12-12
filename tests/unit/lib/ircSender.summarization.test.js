// tests/unit/lib/ircSender.summarization.test.js

jest.mock('../../../src/lib/logger');
jest.mock('../../../src/components/twitch/ircClient.js');
jest.mock('../../../src/components/llm/geminiClient.js', () => ({
    summarizeText: jest.fn()
}));

import { enqueueMessage, clearMessageQueue, waitForQueueEmpty } from '../../../src/lib/ircSender.js';
import * as geminiClient from '../../../src/components/llm/geminiClient.js';
import { getIrcClient } from '../../../src/components/twitch/ircClient.js';

// Mock IRC client send methods
const mockIrcClient = {
    say: jest.fn(async () => {
        console.log('mockIrcClient.say called');
    }),
    raw: jest.fn(async () => {
        console.log('mockIrcClient.raw called');
    }),
};
getIrcClient.mockReturnValue(mockIrcClient);

function buildLongText(len = 1200) {
    const base = 'This is a long message segment meant to exceed the IRC 500 char limit. ';
    let s = '';
    while (s.length < len) s += base;
    return s;
}

describe('ircSender enqueueMessage summarization behavior', () => {
    beforeEach(() => {
        jest.useRealTimers(); // ensure real timers for queue delay behavior
        jest.clearAllMocks();
        clearMessageQueue(); // Clear any leftover messages from previous tests
    });

    afterEach(async () => {
        // Clean up any pending queue operations
        clearMessageQueue();
        await waitForQueueEmpty();
        jest.useRealTimers();
    });

    test('summarizes long messages via summarizeText and sends summary', async () => {
        const longText = buildLongText(1200);
        const summary = 'Short summary within 400 chars.';
    geminiClient.summarizeText.mockResolvedValue(summary);

        await enqueueMessage('#test', longText, { replyToId: null, skipTranslation: true });

        // Verify summarization was called with correct parameters
    expect(geminiClient.summarizeText).toHaveBeenCalledTimes(1);
    expect(geminiClient.summarizeText).toHaveBeenCalledWith(longText, 400); // SUMMARY_TARGET_LENGTH constant

        // Wait for queue processing to complete
        await waitForQueueEmpty();

        // Verify final message sent is the summary, not original long text
        expect(mockIrcClient.say).toHaveBeenCalledWith('#test', summary);
        expect(mockIrcClient.say).toHaveBeenCalledTimes(1);

        // Verify the summary length is within IRC limits
        expect(summary.length).toBeLessThanOrEqual(500);
    });

    test('falls back to truncation when summarization returns null', async () => {
        const longText = buildLongText(1200);
    geminiClient.summarizeText.mockResolvedValue(null);

        await enqueueMessage('#test', longText, { skipTranslation: true });

        // Verify summarization was attempted
    expect(geminiClient.summarizeText).toHaveBeenCalledTimes(1);
    expect(geminiClient.summarizeText).toHaveBeenCalledWith(longText, 400);

        await waitForQueueEmpty();

        // Verify fallback to truncation occurred
        expect(mockIrcClient.say).toHaveBeenCalledTimes(1);
        const sent = mockIrcClient.say.mock.calls[0][1];
        expect(sent.length).toBeLessThanOrEqual(500);
        expect(sent.endsWith('...')).toBe(true);

        // Verify the truncated text is based on the original long text
        expect(sent).toContain('This is a long message segment');
        expect(sent.length).toBeLessThan(longText.length);
    });

    test('skips summarization when skipLengthProcessing is true but still truncates if needed', async () => {
        const longText = buildLongText(1000);
    geminiClient.summarizeText.mockResolvedValue('irrelevant');

        await enqueueMessage('#test', longText, { skipTranslation: true, skipLengthProcessing: true });

        // Verify summarization was NOT called
    expect(geminiClient.summarizeText).not.toHaveBeenCalled();

        await waitForQueueEmpty();

        // Verify emergency truncation still occurred
        expect(mockIrcClient.say).toHaveBeenCalledTimes(1);
        const sent = mockIrcClient.say.mock.calls[0][1];
        expect(sent.length).toBeLessThanOrEqual(500);
        expect(sent.endsWith('...')).toBe(true);

        // Verify it's still based on original text but not the summary
        expect(sent).toContain('This is a long message segment');
        expect(sent).not.toBe('irrelevant');
    });

    test('handles summary that is still too long after summarization', async () => {
        const longText = buildLongText(1200);
        // Return a summary that is still too long (longer than 500 chars)
        const tooLongSummary = 'A'.repeat(600);
    geminiClient.summarizeText.mockResolvedValue(tooLongSummary);

        await enqueueMessage('#test', longText, { skipTranslation: true });

        // Verify summarization was called
    expect(geminiClient.summarizeText).toHaveBeenCalledTimes(1);

        await waitForQueueEmpty();

        // Verify emergency truncation was applied to the summary itself
        expect(mockIrcClient.say).toHaveBeenCalledTimes(1);
        const sent = mockIrcClient.say.mock.calls[0][1];
    expect(sent.length).toBeLessThanOrEqual(400);
        expect(sent.endsWith('...')).toBe(true);
        // Should start with the summary content, not the original text
        expect(sent.startsWith('A')).toBe(true);
    });

    test('handles empty summary result after trimming', async () => {
        const longText = buildLongText(1200);
        // Return a summary that becomes empty after trimming
    geminiClient.summarizeText.mockResolvedValue('   ');

        await enqueueMessage('#test', longText, { skipTranslation: true });

        // Verify summarization was called
    expect(geminiClient.summarizeText).toHaveBeenCalledTimes(1);

        await waitForQueueEmpty();

        // Should fall back to truncation of original text
        expect(mockIrcClient.say).toHaveBeenCalledTimes(1);
        const sent = mockIrcClient.say.mock.calls[0][1];
        expect(sent.length).toBeLessThanOrEqual(500);
        expect(sent.endsWith('...')).toBe(true);
        expect(sent).toContain('This is a long message segment');
    });

    test('handles summarization API errors gracefully', async () => {
        const longText = buildLongText(1200);
    geminiClient.summarizeText.mockRejectedValue(new Error('API Error'));

        await enqueueMessage('#test', longText, { skipTranslation: true });

        // Verify summarization was attempted
    expect(geminiClient.summarizeText).toHaveBeenCalledTimes(1);

        await waitForQueueEmpty();

        // Should fall back to truncation
        expect(mockIrcClient.say).toHaveBeenCalledTimes(1);
        const sent = mockIrcClient.say.mock.calls[0][1];
        expect(sent.length).toBeLessThanOrEqual(500);
        expect(sent.endsWith('...')).toBe(true);
        expect(sent).toContain('This is a long message segment');
    });

    test('processes messages at or below IRC limit without summarization', async () => {
        const shortText = 'This is a short message under 500 characters.';
    geminiClient.summarizeText.mockResolvedValue('should not be called');

        await enqueueMessage('#test', shortText, { skipTranslation: true });

        // Verify summarization was NOT called for short messages
    expect(geminiClient.summarizeText).not.toHaveBeenCalled();

        await waitForQueueEmpty();

        // Verify original message was sent unchanged
        expect(mockIrcClient.say).toHaveBeenCalledTimes(1);
        expect(mockIrcClient.say).toHaveBeenCalledWith('#test', shortText);
    });
});
