// tests/unit/components/riddle/isAnswerTooSimilar.test.js
import { _isAnswerTooSimilar } from '../../../../src/components/riddle/riddleGameManager.js';

// Mock all heavy dependencies
jest.mock('../../../../src/lib/logger.js');
jest.mock('../../../../src/lib/ircSender.js');
jest.mock('../../../../src/components/context/contextManager.js');
jest.mock('../../../../src/components/llm/geminiClient.js');
jest.mock('../../../../src/lib/translationUtils.js');
jest.mock('../../../../src/components/trivia/triviaQuestionService.js', () => ({
    generateQuestion: jest.fn(),
    verifyAnswer: jest.fn(),
    calculateStringSimilarity: jest.requireActual('../../../../src/components/trivia/triviaQuestionService.js').calculateStringSimilarity,
}));
jest.mock('../../../../src/components/riddle/riddleService.js', () => ({
    generateRiddle: jest.fn(),
    verifyRiddleAnswer: jest.fn(),
}));
jest.mock('../../../../src/components/riddle/riddleStorage.js', () => ({
    loadChannelRiddleConfig: jest.fn().mockResolvedValue({}),
    saveChannelRiddleConfig: jest.fn().mockResolvedValue(),
    recordRiddleResult: jest.fn().mockResolvedValue(),
    updatePlayerScore: jest.fn().mockResolvedValue(),
    getRecentKeywords: jest.fn().mockResolvedValue([]),
    saveRiddleKeywords: jest.fn().mockResolvedValue(),
    getLeaderboard: jest.fn().mockResolvedValue([]),
    clearLeaderboardData: jest.fn().mockResolvedValue({ success: true }),
    getMostRecentRiddlePlayed: jest.fn().mockResolvedValue(null),
    flagRiddleAsProblem: jest.fn().mockResolvedValue(),
    getLatestCompletedSessionInfo: jest.fn().mockResolvedValue(null),
    saveRecentAnswer: jest.fn().mockResolvedValue(),
    getRecentAnswers: jest.fn().mockResolvedValue([]),
}));

describe('Riddle _isAnswerTooSimilar', () => {
    test('returns false when newAnswer is empty', () => {
        expect(_isAnswerTooSimilar('', ['shadow'])).toBe(false);
    });

    test('returns false when excludedAnswers is empty', () => {
        expect(_isAnswerTooSimilar('Shadow', [])).toBe(false);
    });

    test('returns false when excludedAnswers is null', () => {
        expect(_isAnswerTooSimilar('Shadow', null)).toBe(false);
    });

    test('returns true for exact case-insensitive match', () => {
        expect(_isAnswerTooSimilar('Shadow', ['shadow'])).toBe(true);
    });

    test('returns true for containment', () => {
        expect(_isAnswerTooSimilar('Fire', ['fireplace'])).toBe(true);
    });

    test('returns true for reverse containment', () => {
        expect(_isAnswerTooSimilar('Fireplace', ['fire'])).toBe(true);
    });

    test('returns true for high Levenshtein similarity', () => {
        expect(_isAnswerTooSimilar('Mirrorr', ['mirror'])).toBe(true);
    });

    test('returns false for genuinely different answers', () => {
        expect(_isAnswerTooSimilar('Clock', ['shadow', 'mirror', 'echo'])).toBe(false);
    });

    test('returns true if ANY excluded answer matches', () => {
        expect(_isAnswerTooSimilar('Echo', [
            'shadow', 'mirror', 'an echo', 'clock'
        ])).toBe(true);
    });
});
