// tests/unit/handlers/checkinHandler.test.js

jest.mock('../../../src/lib/logger.js');
jest.mock('../../../src/lib/ircSender.js');
jest.mock('../../../src/components/customCommands/checkinStorage.js');
jest.mock('../../../src/components/customCommands/variableParser.js');
jest.mock('../../../src/components/customCommands/promptResolver.js');

import { handleCheckinRedemption } from '../../../src/handlers/checkinHandler.js';
import { enqueueMessage } from '../../../src/lib/ircSender.js';
import { getCheckinConfig, recordCheckin } from '../../../src/components/customCommands/checkinStorage.js';
import { parseVariables } from '../../../src/components/customCommands/variableParser.js';
import { resolvePrompt } from '../../../src/components/customCommands/promptResolver.js';

describe('checkinHandler', () => {
    const baseEvent = {
        broadcaster_user_login: 'TestChannel',
        reward: { id: 'reward-123' },
        user_id: 'user-456',
        user_name: 'TestViewer',
    };

    beforeEach(() => {
        jest.clearAllMocks();
        parseVariables.mockImplementation(async (template) => template);
    });

    // ─── Guard clauses ──────────────────────────────────────────────────────

    describe('guard clauses', () => {
        test('returns silently when event is missing broadcaster_user_login', async () => {
            await handleCheckinRedemption({ ...baseEvent, broadcaster_user_login: undefined, broadcaster_user_name: undefined });
            expect(getCheckinConfig).not.toHaveBeenCalled();
        });

        test('returns silently when event is missing reward id', async () => {
            await handleCheckinRedemption({ ...baseEvent, reward: {} });
            expect(getCheckinConfig).not.toHaveBeenCalled();
        });

        test('returns silently when event is missing user_id', async () => {
            await handleCheckinRedemption({ ...baseEvent, user_id: undefined });
            expect(getCheckinConfig).not.toHaveBeenCalled();
        });

        test('returns silently when config is null', async () => {
            getCheckinConfig.mockResolvedValue(null);
            await handleCheckinRedemption(baseEvent);
            expect(recordCheckin).not.toHaveBeenCalled();
        });

        test('returns silently when check-in is disabled', async () => {
            getCheckinConfig.mockResolvedValue({ enabled: false, rewardId: 'reward-123' });
            await handleCheckinRedemption(baseEvent);
            expect(recordCheckin).not.toHaveBeenCalled();
        });

        test('returns silently when reward ID does not match', async () => {
            getCheckinConfig.mockResolvedValue({ enabled: true, rewardId: 'other-reward' });
            await handleCheckinRedemption(baseEvent);
            expect(recordCheckin).not.toHaveBeenCalled();
        });
    });

    // ─── Static template mode ───────────────────────────────────────────────

    describe('static template mode', () => {
        beforeEach(() => {
            getCheckinConfig.mockResolvedValue({
                enabled: true,
                rewardId: 'reward-123',
                useAi: false,
                responseTemplate: '$(user) checked in! Day #$(checkin_count)',
            });
            recordCheckin.mockResolvedValue({ count: 14, isNew: false });
        });

        test('sends parsed template as message', async () => {
            parseVariables.mockResolvedValue('TestViewer checked in! Day #14');

            await handleCheckinRedemption(baseEvent);

            expect(recordCheckin).toHaveBeenCalledWith('testchannel', 'user-456', 'TestViewer');
            expect(parseVariables).toHaveBeenCalledWith(
                '$(user) checked in! Day #$(checkin_count)',
                expect.objectContaining({
                    user: 'TestViewer',
                    channel: 'testchannel',
                    checkinCount: 14,
                })
            );
            expect(enqueueMessage).toHaveBeenCalledWith('#testchannel', 'TestViewer checked in! Day #14');
        });

        test('uses default message when no template is set', async () => {
            getCheckinConfig.mockResolvedValue({
                enabled: true,
                rewardId: 'reward-123',
                useAi: false,
                responseTemplate: null,
            });
            recordCheckin.mockResolvedValue({ count: 7, isNew: false });

            await handleCheckinRedemption(baseEvent);

            expect(enqueueMessage).toHaveBeenCalledWith('#testchannel', '@TestViewer Daily check-in #7! 🎉');
        });

        test('uses broadcaster_user_name as fallback for channel', async () => {
            const event = { ...baseEvent, broadcaster_user_login: undefined, broadcaster_user_name: 'FallbackChannel' };
            getCheckinConfig.mockResolvedValue({
                enabled: true,
                rewardId: 'reward-123',
                useAi: false,
                responseTemplate: null,
            });
            recordCheckin.mockResolvedValue({ count: 1, isNew: true });

            await handleCheckinRedemption(event);

            expect(getCheckinConfig).toHaveBeenCalledWith('fallbackchannel');
        });

        test('uses user_login as fallback when user_name is missing', async () => {
            const event = { ...baseEvent, user_name: undefined, user_login: 'testlogin' };
            recordCheckin.mockResolvedValue({ count: 3, isNew: false });
            parseVariables.mockResolvedValue('testlogin checked in! Day #3');

            await handleCheckinRedemption(event);

            expect(recordCheckin).toHaveBeenCalledWith('testchannel', 'user-456', 'testlogin');
        });
    });

    // ─── AI mode ────────────────────────────────────────────────────────────

    describe('AI mode', () => {
        beforeEach(() => {
            getCheckinConfig.mockResolvedValue({
                enabled: true,
                rewardId: 'reward-123',
                useAi: true,
                aiPrompt: 'Write a fun check-in message for $(user), check-in #$(checkin_count)',
                responseTemplate: 'Fallback: $(user) #$(checkin_count)',
            });
            recordCheckin.mockResolvedValue({ count: 14, isNew: false });
        });

        test('sends AI-generated response when successful', async () => {
            parseVariables.mockResolvedValue('Write a fun check-in message for TestViewer, check-in #14');
            resolvePrompt.mockResolvedValue('TestViewer, 14 days strong! You absolute legend! 🎉');

            await handleCheckinRedemption(baseEvent);

            expect(parseVariables).toHaveBeenCalledWith(
                'Write a fun check-in message for $(user), check-in #$(checkin_count)',
                expect.objectContaining({ checkinCount: 14 })
            );
            expect(resolvePrompt).toHaveBeenCalledWith(
                'Write a fun check-in message for TestViewer, check-in #14',
                'testchannel',
                'TestViewer'
            );
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'TestViewer, 14 days strong! You absolute legend! 🎉'
            );
        });

        test('falls back to static template when AI returns empty', async () => {
            parseVariables
                .mockResolvedValueOnce('resolved prompt')     // AI prompt parse
                .mockResolvedValueOnce('Fallback: TestViewer #14'); // Static template parse
            resolvePrompt.mockResolvedValue(null);

            await handleCheckinRedemption(baseEvent);

            expect(enqueueMessage).toHaveBeenCalledWith('#testchannel', 'Fallback: TestViewer #14');
        });

        test('falls back to static template when AI throws error', async () => {
            parseVariables
                .mockResolvedValueOnce('resolved prompt')     // AI prompt parse
                .mockResolvedValueOnce('Fallback: TestViewer #14'); // Static template parse
            resolvePrompt.mockRejectedValue(new Error('Gemini API down'));

            await handleCheckinRedemption(baseEvent);

            expect(enqueueMessage).toHaveBeenCalledWith('#testchannel', 'Fallback: TestViewer #14');
        });

        test('falls back to default message when AI fails and no template set', async () => {
            getCheckinConfig.mockResolvedValue({
                enabled: true,
                rewardId: 'reward-123',
                useAi: true,
                aiPrompt: 'prompt',
                responseTemplate: null,
            });
            recordCheckin.mockResolvedValue({ count: 5, isNew: false });
            parseVariables.mockResolvedValue('prompt');
            resolvePrompt.mockResolvedValue(null);

            await handleCheckinRedemption(baseEvent);

            expect(enqueueMessage).toHaveBeenCalledWith('#testchannel', '@TestViewer Daily check-in #5! 🎉');
        });

        test('skips AI when useAi is true but aiPrompt is empty', async () => {
            getCheckinConfig.mockResolvedValue({
                enabled: true,
                rewardId: 'reward-123',
                useAi: true,
                aiPrompt: '',
                responseTemplate: '$(user) checked in!',
            });
            recordCheckin.mockResolvedValue({ count: 1, isNew: true });
            parseVariables.mockResolvedValue('TestViewer checked in!');

            await handleCheckinRedemption(baseEvent);

            expect(resolvePrompt).not.toHaveBeenCalled();
            expect(enqueueMessage).toHaveBeenCalledWith('#testchannel', 'TestViewer checked in!');
        });
    });

    // ─── Context building ───────────────────────────────────────────────────

    describe('context building', () => {
        test('passes correct context to parseVariables', async () => {
            getCheckinConfig.mockResolvedValue({
                enabled: true,
                rewardId: 'reward-123',
                useAi: false,
                responseTemplate: 'template',
            });
            recordCheckin.mockResolvedValue({ count: 42, isNew: false });
            parseVariables.mockResolvedValue('resolved');

            await handleCheckinRedemption(baseEvent);

            expect(parseVariables).toHaveBeenCalledWith('template', {
                user: 'TestViewer',
                channel: 'testchannel',
                args: [],
                useCount: 42,
                checkinCount: 42,
            });
        });
    });
});
