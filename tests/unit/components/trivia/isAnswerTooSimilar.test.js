// tests/unit/components/trivia/isAnswerTooSimilar.test.js
import { _isAnswerTooSimilar } from '../../../../src/components/trivia/triviaGameManager.js';

// Mock all of triviaGameManager's heavy dependencies so this test
// loads only the pure helper we want to test.
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
jest.mock('../../../../src/components/trivia/triviaStorage.js', () => ({
    loadChannelConfig: jest.fn().mockResolvedValue({}),
    saveChannelConfig: jest.fn().mockResolvedValue(),
    recordGameResult: jest.fn().mockResolvedValue(),
    updatePlayerScore: jest.fn().mockResolvedValue(),
    getRecentQuestions: jest.fn().mockResolvedValue([]),
    getRecentAnswers: jest.fn().mockResolvedValue([]),
    getLeaderboard: jest.fn().mockResolvedValue([]),
    clearChannelLeaderboardData: jest.fn().mockResolvedValue({ success: true }),
    getLatestCompletedSessionInfo: jest.fn().mockResolvedValue(null),
    flagTriviaQuestionProblem: jest.fn().mockResolvedValue(),
    flagTriviaQuestionByDocId: jest.fn().mockResolvedValue(),
}));

describe('_isAnswerTooSimilar', () => {
    // --- Edge cases: should return false ---
    test('returns false when newAnswer is empty', () => {
        expect(_isAnswerTooSimilar('', ['wilbur'])).toBe(false);
    });

    test('returns false when excludedAnswers is empty', () => {
        expect(_isAnswerTooSimilar('Wilbur', [])).toBe(false);
    });

    test('returns false when excludedAnswers is null', () => {
        expect(_isAnswerTooSimilar('Wilbur', null)).toBe(false);
    });

    // --- Exact match ---
    test('returns true for exact case-insensitive match', () => {
        expect(_isAnswerTooSimilar('Daisy Mae', ['daisy mae'])).toBe(true);
    });

    test('returns true for exact match with extra punctuation', () => {
        expect(_isAnswerTooSimilar("Daisy Mae!", ['daisy mae'])).toBe(true);
    });

    // --- Containment ---
    test('returns true when new answer is contained in excluded answer', () => {
        // "wilbur" is contained in "orville and wilbur"
        expect(_isAnswerTooSimilar('Wilbur', ['orville and wilbur'])).toBe(true);
    });

    test('returns true when excluded answer is contained in new answer', () => {
        // "orville" is contained in "orville and wilbur"
        expect(_isAnswerTooSimilar('Orville and Wilbur', ['orville'])).toBe(true);
    });

    test('does not trigger containment for very short strings (<3 chars)', () => {
        // Short strings like "it" should not trigger containment
        expect(_isAnswerTooSimilar('it', ['iteration'])).toBe(false);
    });

    // --- Levenshtein similarity ---
    test('returns true for high similarity strings (typo-like)', () => {
        // "celeste" vs "celest" — very high similarity
        expect(_isAnswerTooSimilar('Celest', ['celeste'])).toBe(true);
    });

    // --- Genuinely different answers ---
    test('returns false for genuinely different answers', () => {
        expect(_isAnswerTooSimilar('Isabelle', ['tom nook', 'daisy mae', 'celeste'])).toBe(false);
    });

    test('returns false for partial word overlap that is not containment', () => {
        // "meteor" vs "metal" — not contained, low similarity
        expect(_isAnswerTooSimilar('Meteor', ['metal'])).toBe(false);
    });

    // --- Multiple excluded answers ---
    test('returns true if ANY excluded answer matches', () => {
        expect(_isAnswerTooSimilar('Wilbur', [
            'tom nook',
            'isabelle',
            'orville and wilbur',
            'celeste'
        ])).toBe(true);
    });
});
