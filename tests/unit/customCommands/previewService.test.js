// tests/unit/customCommands/previewService.test.js

jest.mock('../../../src/lib/logger.js');
jest.mock('../../../src/components/customCommands/promptResolver.js');
jest.mock('../../../src/components/context/contextManager.js');
jest.mock('../../../src/components/llm/gemini/prompts.js');
jest.mock('../../../src/components/timers/timerManager.js', () => ({
    buildTimerStreamContext: jest.fn(),
}));

import {
    generatePreview,
    validatePreviewRequest,
    PREVIEW_KINDS,
} from '../../../src/components/customCommands/previewService.js';
import { resolvePrompt } from '../../../src/components/customCommands/promptResolver.js';
import { getContextManager } from '../../../src/components/context/contextManager.js';
import { buildContextPrompt } from '../../../src/components/llm/gemini/prompts.js';
import { buildTimerStreamContext } from '../../../src/components/timers/timerManager.js';
import { logInference } from '../../../src/components/llm/inferenceHistoryStorage.js';

jest.mock('../../../src/components/llm/inferenceHistoryStorage.js', () => ({
    CHECKIN_SOURCE: 'checkin',
    customCommandSource: (name) => `custom:${name}`,
    timerSource: (name) => `timer:${name}`,
    logInference: jest.fn(),
    getRecentInferences: jest.fn().mockResolvedValue([]),
}));

describe('previewService', () => {
    const mockContextManager = {
        getBotLanguage: jest.fn(),
        getStreamContextSnapshot: jest.fn(),
        getContextForLLM: jest.fn(),
    };

    beforeEach(() => {
        jest.clearAllMocks();
        getContextManager.mockReturnValue(mockContextManager);
        mockContextManager.getBotLanguage.mockReturnValue(null);
        mockContextManager.getStreamContextSnapshot.mockReturnValue({ game: 'Celeste', title: 'chill run', startedAt: null });
        mockContextManager.getContextForLLM.mockReturnValue({
            streamGame: 'Celeste',
            streamTitle: 'chill run',
            recentChatHistory: 'viewer1: hi\nviewer2: hello',
        });
        buildTimerStreamContext.mockReturnValue('Game: Celeste | Title: chill run');
        buildContextPrompt.mockReturnValue('Channel: testchannel\nGame: Celeste');
        resolvePrompt.mockResolvedValue('A generated reply');
    });

    describe('validatePreviewRequest', () => {
        const valid = { channel: 'testchannel', kind: 'command', prompt: 'Say hi to $(user)' };

        test('accepts a well-formed body', () => {
            expect(validatePreviewRequest(valid)).toBeNull();
            expect(validatePreviewRequest({ ...valid, name: 'hello', args: 'foo bar' })).toBeNull();
        });

        test('rejects non-object bodies', () => {
            expect(validatePreviewRequest(null)).toMatch(/JSON object/);
            expect(validatePreviewRequest('x')).toMatch(/JSON object/);
        });

        test('rejects bad channel names', () => {
            expect(validatePreviewRequest({ ...valid, channel: '#chan' })).toMatch(/channel/i);
            expect(validatePreviewRequest({ ...valid, channel: '' })).toMatch(/channel/i);
        });

        test('rejects unknown kinds', () => {
            expect(validatePreviewRequest({ ...valid, kind: 'persona' })).toMatch(/kind/);
            for (const kind of PREVIEW_KINDS) {
                expect(validatePreviewRequest({ ...valid, kind })).toBeNull();
            }
        });

        test('rejects empty or oversized prompts', () => {
            expect(validatePreviewRequest({ ...valid, prompt: '   ' })).toMatch(/prompt/);
            expect(validatePreviewRequest({ ...valid, prompt: 'x'.repeat(501) })).toMatch(/500/);
        });

        test('rejects bad names and oversized args', () => {
            expect(validatePreviewRequest({ ...valid, name: 'Bad Name' })).toMatch(/name/i);
            expect(validatePreviewRequest({ ...valid, args: 'x'.repeat(201) })).toMatch(/args/);
        });
    });

    describe('generatePreview', () => {
        test('command: resolves variables with a sample viewer and runs a dry-run inference', async () => {
            const result = await generatePreview({
                channel: 'testchannel',
                kind: 'command',
                prompt: 'Greet $(user) in $(channel) about $(args), it is use #$(count) playing $(game)',
                name: 'hello',
                args: 'cats and dogs',
            });

            expect(result.resolvedPrompt).toBe('Greet testchannel in testchannel about cats and dogs, it is use #1 playing Celeste');
            expect(result.response).toBe('A generated reply');
            expect(resolvePrompt).toHaveBeenCalledWith(
                result.resolvedPrompt,
                null,
                null, // commands pass no stream-context block, as in commandProcessor
                false,
                expect.objectContaining({
                    channel: 'testchannel',
                    source: 'custom:hello',
                    chatContext: 'viewer1: hi\nviewer2: hello',
                    dryRun: true,
                }),
            );
        });

        test('command: $(followage) resolves to a stand-in without a Helix lookup', async () => {
            const result = await generatePreview({ channel: 'testchannel', kind: 'command', prompt: 'Followed for $(followage)' });
            expect(result.resolvedPrompt).toMatch(/^Followed for \d/);
        });

        test('timer: uses the timer stream context and flex tier', async () => {
            const result = await generatePreview({ channel: 'testchannel', kind: 'timer', prompt: 'Hype up $(game)', name: 'hype' });

            expect(result.resolvedPrompt).toBe('Hype up Celeste');
            expect(mockContextManager.getContextForLLM).toHaveBeenCalledWith('testchannel', 'system', 'timer');
            expect(resolvePrompt).toHaveBeenCalledWith(
                'Hype up Celeste',
                null,
                'Game: Celeste | Title: chill run',
                false,
                expect.objectContaining({ source: 'timer:hype', serviceTier: 'flex', dryRun: true }),
            );
        });

        test('checkin: uses the full context prompt, checkin hint, and checkin source', async () => {
            const result = await generatePreview({ channel: 'testchannel', kind: 'checkin', prompt: 'Congratulate $(user) on check-in #$(checkin_count)' });

            expect(result.resolvedPrompt).toBe('Congratulate testchannel on check-in #1');
            expect(buildContextPrompt).toHaveBeenCalled();
            expect(resolvePrompt).toHaveBeenCalledWith(
                result.resolvedPrompt,
                null,
                'Channel: testchannel\nGame: Celeste',
                true,
                expect.objectContaining({ source: 'checkin', dryRun: true }),
            );
        });

        test('passes the channel bot language through', async () => {
            mockContextManager.getBotLanguage.mockReturnValue('Spanish');
            const result = await generatePreview({ channel: 'testchannel', kind: 'timer', prompt: 'x' });
            expect(result.language).toBe('Spanish');
            expect(resolvePrompt.mock.calls[0][1]).toBe('Spanish');
        });

        test('falls back to a default source name when no name is given', async () => {
            await generatePreview({ channel: 'testchannel', kind: 'command', prompt: 'x' });
            expect(resolvePrompt.mock.calls[0][4].source).toBe('custom:preview');
        });

        test('returns response null when the LLM produces nothing', async () => {
            resolvePrompt.mockResolvedValue(null);
            const result = await generatePreview({ channel: 'testchannel', kind: 'command', prompt: 'x' });
            expect(result.response).toBeNull();
        });

        test('survives a channel the bot has no context for', async () => {
            mockContextManager.getContextForLLM.mockReturnValue(null);
            mockContextManager.getStreamContextSnapshot.mockReturnValue(null);
            const result = await generatePreview({ channel: 'unknownchan', kind: 'checkin', prompt: 'Hi $(user)' });
            expect(result.resolvedPrompt).toBe('Hi unknownchan');
            expect(resolvePrompt.mock.calls[0][2]).toBeNull();
            expect(resolvePrompt.mock.calls[0][4].chatContext).toBeNull();
        });

        test('never writes to the inference history', async () => {
            await generatePreview({ channel: 'testchannel', kind: 'command', prompt: 'x' });
            expect(logInference).not.toHaveBeenCalled();
        });

        test('rejects an unknown kind', async () => {
            await expect(generatePreview({ channel: 'testchannel', kind: 'nope', prompt: 'x' })).rejects.toThrow(/Unknown preview kind/);
        });
    });
});
