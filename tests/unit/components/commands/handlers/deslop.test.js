// tests/unit/components/commands/handlers/deslop.test.js

jest.mock('../../../../../src/lib/logger.js');
jest.mock('../../../../../src/lib/ircSender.js');
jest.mock('../../../../../src/components/context/contextManager.js');
jest.mock('../../../../../src/components/context/responseStyleStorage.js');
jest.mock('../../../../../src/components/llm/llmClient.js', () => ({
    resetChatSession: jest.fn(),
}));
jest.mock('../../../../../src/components/llm/llmUtils.js', () => ({
    resolveSharedSessionId: jest.fn(),
}));

import deslopHandler from '../../../../../src/components/commands/handlers/deslop.js';
import { enqueueMessage } from '../../../../../src/lib/ircSender.js';
import { getContextManager } from '../../../../../src/components/context/contextManager.js';
import { isDeslopEnabled, setDeslopEnabled } from '../../../../../src/components/context/responseStyleStorage.js';
import { resetChatSession } from '../../../../../src/components/llm/llmClient.js';
import { resolveSharedSessionId } from '../../../../../src/components/llm/llmUtils.js';

describe('Deslop Command Handler', () => {
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const run = args => deslopHandler.execute({
        channel: '#testchannel',
        user: { username: 'mod', id: 'msg-1' },
        args,
        logger,
    });
    const sentText = () => enqueueMessage.mock.calls.map(call => call[1]);

    beforeEach(() => {
        jest.clearAllMocks();
        enqueueMessage.mockResolvedValue();
        getContextManager.mockReturnValue({ getBotLanguage: () => null });
        isDeslopEnabled.mockReturnValue(false);
        setDeslopEnabled.mockResolvedValue();
        resolveSharedSessionId.mockResolvedValue(null);
    });

    test('is a moderator command with a usage line', () => {
        expect(deslopHandler.permission).toBe('moderator');
        expect(deslopHandler.usage).toBe('!deslop [on|off]');
    });

    test('reports the current state without changing it', async () => {
        await run([]);
        expect(sentText()).toEqual(['De-Slop is off. Mods can turn it on with !deslop on.']);

        enqueueMessage.mockClear();
        isDeslopEnabled.mockReturnValue(true);
        await run(['status']);
        expect(sentText()).toEqual(['De-Slop is on. Mods can turn it off with !deslop off.']);

        expect(setDeslopEnabled).not.toHaveBeenCalled();
        expect(resetChatSession).not.toHaveBeenCalled();
    });

    test('turns it on, resets the chat session and replies to the message', async () => {
        await run(['ON']);

        expect(setDeslopEnabled).toHaveBeenCalledWith('testchannel', true);
        expect(resetChatSession).toHaveBeenCalledWith('testchannel');
        expect(enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            expect.stringMatching(/^De-Slop is on\./),
            expect.objectContaining({ replyToId: 'msg-1' }),
        );
    });

    test('also resets the shared-chat session the channel is in', async () => {
        resolveSharedSessionId.mockResolvedValue('shared-1');
        await run(['on']);

        expect(resolveSharedSessionId).toHaveBeenCalledWith('testchannel');
        expect(resetChatSession).toHaveBeenCalledWith('testchannel');
        expect(resetChatSession).toHaveBeenCalledWith('shared-1');
    });

    test('resets only the channel session outside shared chat', async () => {
        await run(['on']);
        expect(resetChatSession).toHaveBeenCalledTimes(1);
    });

    test('turns it off', async () => {
        isDeslopEnabled.mockReturnValue(true);
        await run(['off']);

        expect(setDeslopEnabled).toHaveBeenCalledWith('testchannel', false);
        expect(resetChatSession).toHaveBeenCalledWith('testchannel');
        expect(sentText()).toEqual(['De-Slop is off. Turn it back on with !deslop on.']);
    });

    test('confirms without a write or a session reset when nothing changes', async () => {
        isDeslopEnabled.mockReturnValue(true);
        await run(['on']);

        expect(setDeslopEnabled).not.toHaveBeenCalled();
        expect(resetChatSession).not.toHaveBeenCalled();
        expect(sentText()[0]).toMatch(/^De-Slop is on\./);
    });

    test('reports a failed write and keeps the session', async () => {
        setDeslopEnabled.mockRejectedValue(new Error('unavailable'));
        await run(['on']);

        expect(resetChatSession).not.toHaveBeenCalled();
        expect(sentText()).toEqual([`Sorry, I couldn't change that setting. Please try again later.`]);
        expect(logger.error).toHaveBeenCalled();
    });
});
