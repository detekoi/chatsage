// tests/unit/components/commands/handlers/auto.test.js

jest.mock('../../../../../src/lib/logger.js');
jest.mock('../../../../../src/lib/ircSender.js');
jest.mock('../../../../../src/components/context/contextManager.js');
jest.mock('../../../../../src/components/context/autoChatStorage.js');

import autoHandler from '../../../../../src/components/commands/handlers/auto.js';
import { enqueueMessage } from '../../../../../src/lib/ircSender.js';
import { getContextManager } from '../../../../../src/components/context/contextManager.js';
import {
    getChannelAutoChatConfig,
    saveChannelAutoChatConfig,
    normalizeConfig
} from '../../../../../src/components/context/autoChatStorage.js';

const EN_USAGE = 'Usage: !auto [off|low|medium|high] or !auto config greetings:<on|off> facts:<on|off> questions:<on|off> follows:<on|off> subscriptions:<on|off> raids:<on|off> ads:<on|off>';

describe('Auto Command Handler', () => {
    const run = args => autoHandler.execute({ channel: '#testchannel', args, logger: { info: jest.fn() } });

    beforeEach(() => {
        jest.clearAllMocks();
        enqueueMessage.mockResolvedValue();
        getContextManager.mockReturnValue({ getBotLanguage: () => null });
        getChannelAutoChatConfig.mockResolvedValue({ mode: 'low', categories: { greetings: true, facts: false } });
        saveChannelAutoChatConfig.mockResolvedValue();
        normalizeConfig.mockImplementation(cfg => cfg);
    });

    test('reports the current config in English by default', async () => {
        await run([]);
        expect(enqueueMessage).toHaveBeenCalledWith('#testchannel', `Auto-chat: mode=low, cats=greetings. ${EN_USAGE}`);
    });

    test('confirms a mode change', async () => {
        await run(['high']);
        expect(saveChannelAutoChatConfig).toHaveBeenCalledWith('testchannel', expect.objectContaining({ mode: 'high' }));
        expect(enqueueMessage).toHaveBeenCalledWith('#testchannel', 'Auto-chat mode set to high.');
    });

    test('shows usage for an unknown subcommand', async () => {
        await run(['bogus']);
        expect(enqueueMessage).toHaveBeenCalledWith('#testchannel', EN_USAGE);
    });

    test('localizes the status line, including the embedded usage text', async () => {
        getContextManager.mockReturnValue({ getBotLanguage: () => 'spanish' });
        await run([]);
        const [, text, options] = enqueueMessage.mock.calls[0];
        expect(text).toMatch(/^Auto-chat: mode=low, cats=greetings\. Uso: !auto /);
        expect(text).not.toContain('Usage:');
        expect(options).toEqual({ skipTranslation: true });
    });

    test('localizes a mode change confirmation', async () => {
        getContextManager.mockReturnValue({ getBotLanguage: () => 'spanish' });
        await run(['medium']);
        expect(enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            'Modo de auto-chat establecido en medium.',
            { skipTranslation: true }
        );
    });
});
