// tests/unit/components/commands/commandProcessor.yield.test.js
// A built-in marked yieldsToCustomCommand (!so) gives way to a channel's own custom command of the same name.

jest.mock('../../../../src/lib/logger.js');
jest.mock('../../../../src/lib/activityLogger.js');
jest.mock('../../../../src/lib/ircSender.js');
jest.mock('../../../../src/lib/pronounService.js', () => ({
    pronounService: { getUserPronouns: jest.fn().mockResolvedValue(null) },
}));
jest.mock('../../../../src/components/context/contextManager.js');
jest.mock('../../../../src/components/context/commandStateManager.js', () => ({
    isCommandDisabled: jest.fn(() => false),
}));
jest.mock('../../../../src/components/customCommands/customCommandsStorage.js', () => ({
    getCustomCommand: jest.fn(),
    incrementUseCount: jest.fn().mockResolvedValue(1),
}));
jest.mock('../../../../src/components/customCommands/variableParser.js', () => ({
    parseVariables: jest.fn(async (text) => text),
    formatFollowAge: jest.fn(),
}));
jest.mock('../../../../src/components/customCommands/promptResolver.js');
jest.mock('../../../../src/components/twitch/helixClient.js');
jest.mock('../../../../src/components/twitch/broadcasterTokenHelper.js');
jest.mock('../../../../src/components/llm/llmRequestLog.js', () => ({
    withLlmCaller: jest.fn((_caller, fn) => fn()),
}));
jest.mock('../../../../src/components/llm/inferenceHistoryStorage.js');
jest.mock('../../../../src/components/commands/handlers/index.js', () => ({
    __esModule: true,
    default: {
        so: { execute: jest.fn(), permission: 'moderator', yieldsToCustomCommand: true },
        ping: { execute: jest.fn(), permission: 'everyone' },
    },
}));

import { processMessage } from '../../../../src/components/commands/commandProcessor.js';
import commandHandlers from '../../../../src/components/commands/handlers/index.js';
import { getCustomCommand } from '../../../../src/components/customCommands/customCommandsStorage.js';
import { enqueueMessage } from '../../../../src/lib/ircSender.js';
import { getContextManager } from '../../../../src/components/context/contextManager.js';

const modTags = (id) => ({ username: 'moduser', 'display-name': 'ModUser', mod: true, id });

describe('commandProcessor: built-ins that yield to a custom command', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getContextManager.mockReturnValue({
            getStreamContextSnapshot: () => ({}),
            getBotLanguage: () => null,
        });
        enqueueMessage.mockResolvedValue();
    });

    test("runs the channel's custom !so instead of the built-in", async () => {
        getCustomCommand.mockResolvedValue({ name: 'so', response: 'Check out my friend!', permission: 'moderator' });

        await expect(processMessage('testchannel', modTags('m1'), '!so idzuna')).resolves.toBe(true);

        expect(getCustomCommand).toHaveBeenCalledWith('testchannel', 'so');
        expect(enqueueMessage).toHaveBeenCalledWith('#testchannel', 'Check out my friend!', { skipTranslation: false });
        expect(commandHandlers.so.execute).not.toHaveBeenCalled();
    });

    test('runs the built-in !so when the channel has no custom one', async () => {
        getCustomCommand.mockResolvedValue(null);

        await expect(processMessage('testchannel', modTags('m2'), '!so idzuna')).resolves.toBe(true);

        expect(commandHandlers.so.execute).toHaveBeenCalledTimes(1);
    });

    test('does not look up a custom command for other built-ins', async () => {
        await processMessage('testchannel', modTags('m3'), '!ping');

        expect(getCustomCommand).not.toHaveBeenCalled();
        expect(commandHandlers.ping.execute).toHaveBeenCalledTimes(1);
    });
});
