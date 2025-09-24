// tests/unit/components/riddle/riddleGameManager.test.js
import { getRiddleGameManager, activeGames } from '../../../../src/components/riddle/riddleGameManager.js';
import { getContextManager } from '../../../../src/components/context/contextManager.js';
import { translateText } from '../../../../src/lib/translationUtils.js';
import { verifyRiddleAnswer } from '../../../../src/components/riddle/riddleService.js';
import logger from '../../../../src/lib/logger.js';

// Mock dependencies
jest.mock('../../../../src/components/context/contextManager.js');
jest.mock('../../../../src/components/llm/geminiClient.js');
jest.mock('../../../../src/lib/translationUtils.js');
jest.mock('../../../../src/components/riddle/riddleService.js');
jest.mock('../../../../src/lib/logger.js');
jest.mock('../../../../src/lib/ircSender.js'); // Mock to prevent actual message sending

// Mock riddleStorage functions used by the manager
jest.mock('../../../../src/components/riddle/riddleStorage.js', () => ({
    loadChannelRiddleConfig: jest.fn().mockResolvedValue({}),
    saveChannelRiddleConfig: jest.fn().mockResolvedValue(),
    recordRiddleResult: jest.fn().mockResolvedValue(),
    updatePlayerScore: jest.fn().mockResolvedValue(),
    getRecentKeywords: jest.fn().mockResolvedValue([]),
    saveRiddleKeywords: jest.fn().mockResolvedValue(),
    getLeaderboard: jest.fn().mockResolvedValue([]),
    clearLeaderboardData: jest.fn().mockResolvedValue({ success: true, message: "Leaderboard cleared." }),
    getMostRecentRiddlePlayed: jest.fn().mockResolvedValue(null),
    flagRiddleAsProblem: jest.fn().mockResolvedValue(),
    getLatestCompletedSessionInfo: jest.fn().mockResolvedValue(null),
    saveRecentAnswer: jest.fn().mockResolvedValue(),
    getRecentAnswers: jest.fn().mockResolvedValue([]),
}));


describe('RiddleGameManager - _handleAnswer (via processPotentialAnswer)', () => {
    let riddleGameManager;
    let mockGameState;

    beforeEach(async () => {
        // Reset all mocks before each test
        jest.clearAllMocks();

        // Clear the activeGames map for testing
        activeGames.clear();

        // Initialize the manager
        riddleGameManager = getRiddleGameManager();
        await riddleGameManager.initialize();


        // Mock getContextManager to return a specific bot language
        getContextManager.mockReturnValue({
            getBotLanguage: jest.fn().mockReturnValue('english'), // Default to English
        });

        // Default mock for verifyRiddleAnswer
        verifyRiddleAnswer.mockResolvedValue({ isCorrect: false });
        
        // Default mock for logger
        logger.debug = jest.fn();
        logger.info = jest.fn();
        logger.warn = jest.fn();
        logger.error = jest.fn();

        // Set up a basic game state for a channel
        // This simulates a game being active so _handleAnswer can be reached
        const channelName = 'testchannel';
        await riddleGameManager.startGame(channelName, null, 'testuser', 1);

        // Access the activeGames directly
        if (activeGames && activeGames.has(channelName)) {
            mockGameState = activeGames.get(channelName);
            mockGameState.state = 'inProgress';
            mockGameState.currentRiddle = {
                question: "What has an eye, but cannot see?",
                answer: "A needle",
                keywords: ["eye", "needle"],
                difficulty: "easy",
                explanation: "A needle has an eye.",
                topic: "general"
            };
            mockGameState.startTime = Date.now();
            mockGameState.userLastGuessTime = {}; // Ensure this is initialized
        } else {
            // Fallback if startGame didn't set up as expected
            console.error("Failed to initialize mockGameState for Riddle tests. startGame did not populate activeGames as expected.");
            mockGameState = {
                channelName,
                state: 'inProgress',
                currentRiddle: { question: "What has an eye, but cannot see?", answer: "A needle", keywords: ["eye", "needle"], difficulty: "easy", explanation: "A needle has an eye.", topic: "general" },
                config: { questionTimeSeconds: 30 },
                startTime: Date.now(),
                userLastGuessTime: {},
                topic: "general",
            };
            activeGames.set(channelName, mockGameState);
        }
    });



    test('1. Bot language is English: translateText NOT called, verifyRiddleAnswer called with original answer', async () => {
        getContextManager().getBotLanguage.mockReturnValue('english');
        const userAnswer = "A needle";
        await riddleGameManager.processPotentialAnswer('testchannel', 'user1', 'User1', userAnswer);

        expect(translateText).not.toHaveBeenCalled();
        expect(verifyRiddleAnswer).toHaveBeenCalledWith(
            mockGameState.currentRiddle.answer,
            userAnswer,
            mockGameState.currentRiddle.question,
            mockGameState.topic 
        );
    });

    test('2. Bot language is Spanish (translation success): translateText called, verifyRiddleAnswer called with translated answer', async () => {
        getContextManager().getBotLanguage.mockReturnValue('spanish');
        const userAnswer = "Una aguja";
        const translatedAnswer = "A needle";
        translateText.mockResolvedValue(translatedAnswer);

        await riddleGameManager.processPotentialAnswer('testchannel', 'user2', 'User2', userAnswer);

        expect(translateText).toHaveBeenCalledWith(userAnswer, 'English');
        expect(verifyRiddleAnswer).toHaveBeenCalledWith(
            mockGameState.currentRiddle.answer,
            translatedAnswer,
            mockGameState.currentRiddle.question,
            mockGameState.topic
        );
    });

    test('3. Bot language is French (translation fails - API error): translateText called, verifyRiddleAnswer called with original answer, logs error', async () => {
        getContextManager().getBotLanguage.mockReturnValue('french');
        const userAnswer = "Une aiguille";
        translateText.mockRejectedValue(new Error("Translation API error"));

        await riddleGameManager.processPotentialAnswer('testchannel', 'user3', 'User3', userAnswer);

        expect(translateText).toHaveBeenCalledWith(userAnswer, 'English');
        expect(verifyRiddleAnswer).toHaveBeenCalledWith(
            mockGameState.currentRiddle.answer,
            userAnswer, // Should fall back to original
            mockGameState.currentRiddle.question,
            mockGameState.topic
        );
        expect(logger.error).toHaveBeenCalled();
    });

    test('4. Bot language is German (translation returns empty string): translateText called, verifyRiddleAnswer called with original answer, logs warning', async () => {
        getContextManager().getBotLanguage.mockReturnValue('german');
        const userAnswer = "Eine Nadel";
        translateText.mockResolvedValue(" "); // Empty or whitespace

        await riddleGameManager.processPotentialAnswer('testchannel', 'user4', 'User4', userAnswer);

        expect(translateText).toHaveBeenCalledWith(userAnswer, 'English');
        expect(verifyRiddleAnswer).toHaveBeenCalledWith(
            mockGameState.currentRiddle.answer,
            userAnswer, // Should fall back to original
            mockGameState.currentRiddle.question,
            mockGameState.topic
        );
        expect(logger.warn).toHaveBeenCalled();
    });
    
    // Test to ensure userLastGuessTime is managed
    test('Spam prevention: subsequent guesses from same user are throttled', async () => {
        getContextManager().getBotLanguage.mockReturnValue('english');
        const userAnswer = "A needle";
        const username = 'userSpam';

        // First guess
        await riddleGameManager.processPotentialAnswer('testchannel', username, 'UserSpam', userAnswer);
        expect(verifyRiddleAnswer).toHaveBeenCalledTimes(1);

        // Immediate second guess - should be throttled (no additional verifyRiddleAnswer call)
        await riddleGameManager.processPotentialAnswer('testchannel', username, 'UserSpam', userAnswer + " again");
        expect(verifyRiddleAnswer).toHaveBeenCalledTimes(1); // Still 1, because it was throttled
    });
});
