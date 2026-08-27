// tests/unit/components/riddle/riddleConfig.test.js

jest.mock('../../../../src/lib/logger.js');
jest.mock('../../../../src/components/riddle/riddleStorage.js');
jest.mock('../../../../src/lib/ircSender.js');
jest.mock('../../../../src/lib/localizedMessage.js');

import { configureRiddleGame } from '../../../../src/components/riddle/riddleGameManager.js';
import { loadChannelRiddleConfig, saveChannelRiddleConfig } from '../../../../src/components/riddle/riddleStorage.js';

describe('configureRiddleGame', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        loadChannelRiddleConfig.mockResolvedValue({});
        saveChannelRiddleConfig.mockResolvedValue();
    });

    // !riddle help advertises nine options; only difficulty and questiontime were implemented,
    // so the rest silently did nothing even once the subcommand was routed.
    it.each([
        ['pointsBase', 50],
        ['maxRounds', 5],
        ['recentKeywordsFetchLimit', 25],
        ['multiRoundDelayMs', 8000],
    ])('applies the numeric option %s', async (option, value) => {
        const result = await configureRiddleGame('chan', { [option]: value });
        expect(result.messageKey).toBe('result.riddle.RiddleSettingsUpdated');
        expect(saveChannelRiddleConfig).toHaveBeenCalledWith('chan', expect.objectContaining({ [option]: value }));
    });

    it.each([
        ['scoreTracking', false],
        ['pointsTimeBonus', false],
        ['pointsDifficultyMultiplier', true],
    ])('applies the boolean option %s', async (option, value) => {
        const result = await configureRiddleGame('chan', { [option]: value });
        expect(result.messageKey).toBe('result.riddle.RiddleSettingsUpdated');
        expect(saveChannelRiddleConfig).toHaveBeenCalledWith('chan', expect.objectContaining({ [option]: value }));
    });

    it('still applies the two options that already worked', async () => {
        await configureRiddleGame('chan', { difficulty: 'hard', questionTimeSeconds: 60 });
        expect(saveChannelRiddleConfig).toHaveBeenCalledWith('chan',
            expect.objectContaining({ difficulty: 'hard', questionTimeSeconds: 60 }));
    });

    it('rejects out-of-range numbers without saving', async () => {
        const result = await configureRiddleGame('chan', { maxRounds: 999 });
        expect(saveChannelRiddleConfig).not.toHaveBeenCalled();
        expect(result.message).toEqual(expect.stringContaining('Invalid maxRounds'));
    });

    it('reports when nothing valid was supplied', async () => {
        const result = await configureRiddleGame('chan', { nonsense: 1 });
        expect(result.messageKey).toBe('result.riddle.NoValidRiddleSettings');
        expect(saveChannelRiddleConfig).not.toHaveBeenCalled();
    });
});
