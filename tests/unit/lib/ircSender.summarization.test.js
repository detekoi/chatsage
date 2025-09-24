// tests/unit/lib/ircSender.summarization.test.js

jest.mock('../../../src/lib/logger');
jest.mock('../../../src/components/twitch/ircClient.js');

import { enqueueMessage, clearMessageQueue, waitForQueueEmpty } from '../../../src/lib/ircSender.js';
import * as geminiClient from '../../../src/components/llm/geminiClient.js';
import { getIrcClient } from '../../../src/components/twitch/ircClient.js';

// Mock IRC client send methods
const mockIrcClient = {
    say: jest.fn(async () => {}),
    raw: jest.fn(async () => {}),
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
        jest.clearAllMocks();
        clearMessageQueue(); // Clear any leftover messages from previous tests
    });

    afterEach(async () => {
        // Clean up any pending queue operations
        clearMessageQueue();
        await waitForQueueEmpty();
    });

    test('summarizes long messages via summarizeText and sends summary', async () => {
        const longText = buildLongText(1200);
        const summary = 'Short summary within 400 chars.';
        jest.spyOn(geminiClient, 'summarizeText').mockResolvedValue(summary);

        await enqueueMessage('#test', longText, { replyToId: null, skipTranslation: true });

        // summarization called
        expect(geminiClient.summarizeText).toHaveBeenCalledTimes(1);
        // final send uses summary, not original long text
        // Wait for queue processing to complete
        await waitForQueueEmpty();
        expect(mockIrcClient.say).toHaveBeenCalledWith('#test', summary);
    });

    test('falls back to truncation when summarization returns null', async () => {
        const longText = buildLongText(1200);
        jest.spyOn(geminiClient, 'summarizeText').mockResolvedValue(null);

        await enqueueMessage('#test', longText, { skipTranslation: true });

        await waitForQueueEmpty();
        expect(mockIrcClient.say).toHaveBeenCalledTimes(1);
        const sent = mockIrcClient.say.mock.calls[0][1];
        expect(sent.length).toBeLessThanOrEqual(500);
        expect(sent.endsWith('...')).toBe(true);
    });

    test('skips summarization when skipLengthProcessing is true but still truncates if needed', async () => {
        const longText = buildLongText(1000);
        const spy = jest.spyOn(geminiClient, 'summarizeText').mockResolvedValue('irrelevant');

        await enqueueMessage('#test', longText, { skipTranslation: true, skipLengthProcessing: true });

        await waitForQueueEmpty();
        expect(spy).not.toHaveBeenCalled();
        expect(mockIrcClient.say).toHaveBeenCalledTimes(1);
        const sent = mockIrcClient.say.mock.calls[0][1];
        expect(sent.length).toBeLessThanOrEqual(500);
    });
});
