// tests/unit/components/geo/isLocationTooSimilar.test.js
import { _isLocationTooSimilar } from '../../../../src/components/geo/geoGameManager.js';

// Mock all of geoGameManager's heavy dependencies
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
jest.mock('../../../../src/components/geo/geoLocationService.js', () => ({
    selectLocation: jest.fn(),
    validateGuess: jest.fn(),
}));
jest.mock('../../../../src/components/geo/geoClueService.js', () => ({
    generateInitialClue: jest.fn(),
    generateFollowUpClue: jest.fn(),
    generateFinalReveal: jest.fn(),
}));
jest.mock('../../../../src/components/geo/geoStorage.js', () => ({
    loadChannelConfig: jest.fn().mockResolvedValue({}),
    saveChannelConfig: jest.fn().mockResolvedValue(),
    recordGameResult: jest.fn().mockResolvedValue(),
    updatePlayerScore: jest.fn().mockResolvedValue(),
    getRecentLocations: jest.fn().mockResolvedValue([]),
    getLeaderboard: jest.fn().mockResolvedValue([]),
    clearChannelLeaderboardData: jest.fn().mockResolvedValue({ success: true }),
    reportProblemLocation: jest.fn().mockResolvedValue({ success: true }),
    getLatestCompletedSessionInfo: jest.fn().mockResolvedValue(null),
    flagGeoLocationByDocId: jest.fn().mockResolvedValue(),
}));

describe('_isLocationTooSimilar', () => {
    // --- Edge cases ---
    test('returns false when newLocation is empty', () => {
        expect(_isLocationTooSimilar('', ['Mount Fuji'])).toBe(false);
    });

    test('returns false when excludedLocations is empty', () => {
        expect(_isLocationTooSimilar('Mount Fuji', [])).toBe(false);
    });

    test('returns false when excludedLocations is null', () => {
        expect(_isLocationTooSimilar('Mount Fuji', null)).toBe(false);
    });

    // --- Exact match ---
    test('returns true for exact case-insensitive match', () => {
        expect(_isLocationTooSimilar('Mount Fuji', ['mount fuji'])).toBe(true);
    });

    test('returns true for match with extra punctuation', () => {
        expect(_isLocationTooSimilar('St. Petersburg', ['st petersburg'])).toBe(true);
    });

    // --- Containment ---
    test('returns true when new location is contained in excluded', () => {
        // "fuji" is contained in "mount fuji"
        expect(_isLocationTooSimilar('Fuji', ['Mount Fuji'])).toBe(true);
    });

    test('returns true when excluded is contained in new location', () => {
        // "colosseum" is contained in "the colosseum"
        expect(_isLocationTooSimilar('The Colosseum', ['Colosseum'])).toBe(true);
    });

    test('does not trigger containment for very short strings (<3 chars)', () => {
        expect(_isLocationTooSimilar('UK', ['United Kingdom'])).toBe(false);
    });

    // --- Levenshtein similarity ---
    test('returns true for high similarity (typo-like)', () => {
        // "colosseum" vs "coliseum" — very high similarity
        expect(_isLocationTooSimilar('Coliseum', ['Colosseum'])).toBe(true);
    });

    // --- Genuinely different ---
    test('returns false for genuinely different locations', () => {
        expect(_isLocationTooSimilar('Tokyo', ['New York', 'London', 'Paris'])).toBe(false);
    });

    test('returns false for partial word overlap that is not containment', () => {
        expect(_isLocationTooSimilar('Grand Canyon', ['Grand Prix'])).toBe(false);
    });

    // --- Multiple excluded ---
    test('returns true if ANY excluded location matches', () => {
        expect(_isLocationTooSimilar('Fuji', [
            'Tokyo',
            'Kyoto',
            'Mount Fuji',
            'Osaka'
        ])).toBe(true);
    });
});
