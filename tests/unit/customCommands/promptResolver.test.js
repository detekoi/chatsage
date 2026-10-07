// tests/unit/customCommands/promptResolver.test.js
import { resolvePrompt, formatHistoryForPrompt } from '../../../src/components/customCommands/promptResolver.js';
import { generateLiteContent } from '../../../src/components/llm/llmClient.js';
import { smartTruncate } from '../../../src/components/llm/llmUtils.js';
import { getRecentInferences, logInference } from '../../../src/components/llm/inferenceHistoryStorage.js';
import { retrieveMemories } from '../../../src/components/memory/memoryManager.js';

jest.mock('../../../src/components/llm/llmClient.js', () => ({
    generateLiteContent: jest.fn()
}));

jest.mock('../../../src/components/llm/llmUtils.js', () => ({
    smartTruncate: jest.fn((text, max) => text.substring(0, max)),
    removeMarkdownAsterisks: jest.fn(text => text ? text.replace(/\*\*/g, '') : text)
}));

jest.mock('../../../src/components/llm/inferenceHistoryStorage.js', () => ({
    getRecentInferences: jest.fn().mockResolvedValue([]),
    logInference: jest.fn().mockResolvedValue(undefined),
    CHECKIN_SOURCE: 'checkin',
    customCommandSource: jest.fn((name) => `custom:${name}`),
}));

jest.mock('../../../src/components/memory/memoryManager.js', () => ({
    retrieveMemories: jest.fn().mockResolvedValue([]),
    formatMemoriesForPrompt: jest.fn(memories => (memories.length
        ? `--- CHANNEL MEMORY ---\n${memories.map(m => `- ${m.text}`).join('\n')}\n--- END CHANNEL MEMORY ---`
        : null)),
}));

jest.mock('../../../src/lib/userIdentity.js', () => ({
    resolveUserIds: jest.fn(async (logins) => new Map(logins.filter(l => l === '@bob').map(() => ['bob', '22']))),
}));

jest.mock('../../../src/lib/logger.js', () => ({
    __esModule: true,
    default: {
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
        error: jest.fn()
    }
}));

describe('promptResolver', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        generateLiteContent.mockResolvedValue('Mocked response');
    });

    test('dryRun reads history for dedup but never logs the new response', async () => {
        getRecentInferences.mockResolvedValueOnce(['old joke']);
        const result = await resolvePrompt('Tell a joke', null, null, false, {
            channel: 'chan', source: 'custom:joke', dryRun: true,
        });

        expect(result).toBe('Mocked response');
        expect(getRecentInferences).toHaveBeenCalledWith('chan', 'custom:joke');
        expect(generateLiteContent.mock.calls[0][0]).toContain('old joke');
        expect(logInference).not.toHaveBeenCalled();
    });

    test('returns empty string if prompt is empty', async () => {
        expect(await resolvePrompt(null)).toBe('');
        expect(await resolvePrompt('')).toBe('');
    });

    test('sends full prompt to LLM', async () => {
        const result = await resolvePrompt('Say something fun');

        expect(generateLiteContent).toHaveBeenCalledWith(
            expect.stringContaining('Say something fun'),
            expect.any(Object)
        );

        expect(result).toBe('Mocked response');
    });

    test('uses the standard tier by default and Flex only when asked', async () => {
        await resolvePrompt('Check-in reply');
        expect(generateLiteContent.mock.calls[0][1]).not.toHaveProperty('serviceTier');

        await resolvePrompt('Timer message', null, null, false, { serviceTier: 'flex' });
        expect(generateLiteContent.mock.calls[1][1]).toHaveProperty('serviceTier', 'flex');
    });

    test('successfully generates and cleans response', async () => {
        generateLiteContent.mockResolvedValue('**A fun string**');
        const result = await resolvePrompt('Say something fun');

        expect(result).toBe('A fun string');
        expect(generateLiteContent).toHaveBeenCalledTimes(1);
    });

    test('returns null on error', async () => {
        generateLiteContent.mockRejectedValue(new Error('API Error'));

        const result = await resolvePrompt('Say something fun');
        expect(result).toBeNull();
    });

    test('truncates response if too long', async () => {
        const longResponse = 'a'.repeat(500);
        generateLiteContent.mockResolvedValue(longResponse);

        const result = await resolvePrompt('Say something fun');
        expect(smartTruncate).toHaveBeenCalledWith(longResponse, 450);
        expect(result).toBe('a'.repeat(450));
    });

    test('includes language directive in system instruction when language is set', async () => {
        generateLiteContent.mockResolvedValue('Hola amigo!');

        await resolvePrompt('Say hello', 'spanish');

        const callOptions = generateLiteContent.mock.calls[0][1];
        expect(callOptions.systemInstruction).toContain('You MUST respond entirely in spanish.');
    });

    test('does not include language directive when language is null', async () => {
        generateLiteContent.mockResolvedValue('Hello friend!');

        await resolvePrompt('Say hello');

        const callOptions = generateLiteContent.mock.calls[0][1];
        expect(callOptions.systemInstruction).not.toContain('You MUST respond entirely in');
    });

    // ─── Stream context ─────────────────────────────────────────────────

    describe('stream context', () => {
        test('appends stream context to prompt when provided', async () => {
            generateLiteContent.mockResolvedValue('Contextual response!');

            await resolvePrompt('Check-in prompt', null, 'Channel: testchannel\nGame: Minecraft');

            const callPrompt = generateLiteContent.mock.calls[0][0];
            expect(callPrompt).toContain('Check-in prompt');
            expect(callPrompt).toContain('--- Stream Context ---');
            expect(callPrompt).toContain('Channel: testchannel');
        });

        test('does not append context block when streamContext is null', async () => {
            generateLiteContent.mockResolvedValue('No context response!');

            await resolvePrompt('Check-in prompt', null, null);

            const callPrompt = generateLiteContent.mock.calls[0][0];
            expect(callPrompt).toBe('Check-in prompt');
            expect(callPrompt).not.toContain('--- Stream Context ---');
        });
    });

    // ─── Chat context ───────────────────────────────────────────────────

    describe('chat context', () => {
        test('appends chat context to prompt when provided', async () => {
            generateLiteContent.mockResolvedValue('Contextual response!');

            await resolvePrompt('Check-in prompt', null, null, false, {
                chatContext: 'user1: hello\nuser2: what game is this',
            });

            const callPrompt = generateLiteContent.mock.calls[0][0];
            expect(callPrompt).toContain('--- Recent Chat');
            expect(callPrompt).toContain('do NOT reply to or address these messages');
            expect(callPrompt).toContain('user1: hello');
            expect(callPrompt).toContain('Now complete the original task stated at the top of this prompt.');
        });

        test('does not append chat context block when chatContext is null', async () => {
            generateLiteContent.mockResolvedValue('No context response!');

            await resolvePrompt('Check-in prompt', null, null, false, { chatContext: null });

            const callPrompt = generateLiteContent.mock.calls[0][0];
            expect(callPrompt).not.toContain('--- Recent Chat');
            expect(callPrompt).not.toContain('Now complete the original task');
        });
    });

    // ─── Encapsulated dedup lifecycle ───────────────────────────────────

    describe('encapsulated dedup lifecycle', () => {
        test('fetches history and injects it when channel+source are provided', async () => {
            getRecentInferences.mockResolvedValue(['prev response 1', 'prev response 2']);
            generateLiteContent.mockResolvedValue('Unique response!');

            await resolvePrompt('Say something', null, null, false, {
                channel: 'testchannel',
                source: 'custom:hug',
            });

            expect(getRecentInferences).toHaveBeenCalledWith('testchannel', 'custom:hug');
            const callPrompt = generateLiteContent.mock.calls[0][0];
            expect(callPrompt).toContain('"prev response 1"');
            expect(callPrompt).toContain('"prev response 2"');
        });

        test('logs inference after successful generation', async () => {
            generateLiteContent.mockResolvedValue('New response!');

            await resolvePrompt('Say something', null, null, false, {
                channel: 'testchannel',
                source: 'checkin',
            });

            expect(logInference).toHaveBeenCalledWith('testchannel', 'checkin', 'New response!');
        });

        test('does NOT log inference when LLM returns empty', async () => {
            generateLiteContent.mockResolvedValue('');
            await resolvePrompt('Check-in prompt', null, null, true, {
                channel: 'testchannel',
                source: 'checkin'
            });

            expect(logInference).not.toHaveBeenCalled();
        });

        test('does NOT log inference when LLM throws error', async () => {
            generateLiteContent.mockRejectedValue(new Error('API Error'));

            await resolvePrompt('Say something', null, null, false, {
                channel: 'testchannel',
                source: 'checkin',
            });

            expect(logInference).not.toHaveBeenCalled();
        });

        test('does not fetch history or log when channel/source are not provided', async () => {
            generateLiteContent.mockResolvedValue('Normal response!');

            await resolvePrompt('Say something');

            expect(getRecentInferences).not.toHaveBeenCalled();
            expect(logInference).not.toHaveBeenCalled();
        });

        test('combines stream context, chat context, and history in correct order', async () => {
            getRecentInferences.mockResolvedValue(['old response']);
            generateLiteContent.mockResolvedValue('Combined response!');

            await resolvePrompt('Check-in base prompt', null, 'Channel: test\nGame: Minecraft', false, {
                channel: 'testchannel',
                source: 'custom:test',
                chatContext: 'user1: hello',
            });

            const callPrompt = generateLiteContent.mock.calls[0][0];

            // Verify ordering: base prompt → stream context → chat context → history
            const baseIndex = callPrompt.indexOf('Check-in base prompt');
            const streamIndex = callPrompt.indexOf('--- Stream Context ---');
            const chatIndex = callPrompt.indexOf('--- Recent Chat');
            const historyIndex = callPrompt.indexOf('--- Your Previous Responses');

            expect(baseIndex).toBeLessThan(streamIndex);
            expect(streamIndex).toBeLessThan(chatIndex);
            expect(chatIndex).toBeLessThan(historyIndex);
        });
    });

    // ─── formatHistoryForPrompt ─────────────────────────────────────────

    describe('channel memory', () => {
        const allergy = { id: 'm1', text: 'sleepysabrinas cannot have tree nuts.' };

        test('adds relevant memories and asks the model to stay consistent with them', async () => {
            retrieveMemories.mockResolvedValueOnce([allergy]);
            await resolvePrompt('Make sleepysabrinas a parfait', null, null, true, {
                channel: 'parfaitfair', source: 'checkin', chatContext: 'chat line', useMemory: true, memoryUserIds: ['33'],
            });

            expect(retrieveMemories).toHaveBeenCalledWith('parfaitfair', {
                text: 'Make sleepysabrinas a parfait', userId: null, recentText: 'chat line', focusUserIds: ['33'],
            }, { trackUsage: true, askerOnlyLimit: Infinity });
            const prompt = generateLiteContent.mock.calls[0][0];
            expect(prompt).toContain('- sleepysabrinas cannot have tree nuts.');
            expect(prompt).toContain('consistent with the channel memory above');
        });

        test('passes the triggering viewer separately from the viewers the response is for', async () => {
            await resolvePrompt('Hug bob', null, null, false, {
                channel: 'parfaitfair', useMemory: true, userId: '44', memoryUserIds: ['55'], memoryLogins: ['@bob', 'hugs'],
            });

            expect(retrieveMemories.mock.calls[0][1]).toEqual(expect.objectContaining({ userId: '44', focusUserIds: ['55', '22'] }));
        });

        test('re-anchors on the task when memory is present without chat context', async () => {
            retrieveMemories.mockResolvedValueOnce([allergy]);
            await resolvePrompt('Make a parfait', null, null, false, { channel: 'parfaitfair', useMemory: true });

            expect(generateLiteContent.mock.calls[0][0]).toContain('Now complete the original task');
        });

        test('skips retrieval unless asked, and adds nothing when no memory matches', async () => {
            await resolvePrompt('Make a parfait', null, null, false, { channel: 'parfaitfair' });
            expect(retrieveMemories).not.toHaveBeenCalled();

            await resolvePrompt('Make a parfait', null, null, false, { channel: 'parfaitfair', useMemory: true });
            expect(retrieveMemories).toHaveBeenCalledTimes(1);
            for (const [prompt] of generateLiteContent.mock.calls) {
                expect(prompt).not.toContain('CHANNEL MEMORY');
                expect(prompt).not.toContain('Now complete the original task');
            }
        });

        test('still responds when retrieval fails', async () => {
            retrieveMemories.mockRejectedValueOnce(new Error('firestore down'));
            const result = await resolvePrompt('Make a parfait', null, null, false, { channel: 'parfaitfair', useMemory: true });

            expect(result).toBe('Mocked response');
            expect(generateLiteContent.mock.calls[0][0]).not.toContain('CHANNEL MEMORY');
        });

        test('a dry run does not count as memory usage', async () => {
            await resolvePrompt('Make a parfait', null, null, false, { channel: 'parfaitfair', useMemory: true, dryRun: true });

            expect(retrieveMemories.mock.calls[0][2]).toEqual(expect.objectContaining({ trackUsage: false }));
        });
    });

    describe('formatHistoryForPrompt', () => {
        test('returns null for empty array', () => {
            expect(formatHistoryForPrompt([])).toBeNull();
        });

        test('returns null for non-array input', () => {
            expect(formatHistoryForPrompt(null)).toBeNull();
            expect(formatHistoryForPrompt(undefined)).toBeNull();
        });

        test('formats responses as numbered list with dedup instruction', () => {
            const result = formatHistoryForPrompt(['Hello there!', 'Welcome back!']);
            expect(result).toContain('DO NOT repeat');
            expect(result).toContain('Rewording the same stories, facts, or jokes counts as repeating');
            expect(result).toContain('1. "Hello there!"');
            expect(result).toContain('2. "Welcome back!"');
        });

        test('preserves order of responses', () => {
            const result = formatHistoryForPrompt(['first', 'second', 'third']);
            const firstIndex = result.indexOf('1. "first"');
            const secondIndex = result.indexOf('2. "second"');
            const thirdIndex = result.indexOf('3. "third"');
            expect(firstIndex).toBeLessThan(secondIndex);
            expect(secondIndex).toBeLessThan(thirdIndex);
        });
    });
});
