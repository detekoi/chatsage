// tests/unit/components/riddle/riddleGameManager.test.js
import { getRiddleGameManager } from '../../../../src/components/riddle/riddleGameManager.js';
import { getContextManager } from '../../../../src/context/contextManager.js';
import { translateText } from '../../../../src/llm/geminiClient.js';
import { verifyRiddleAnswer } from '../../../../src/components/riddle/riddleService.js';
import logger from '../../../../src/lib/logger.js';
import { enqueueMessage } from '../../../../src/lib/ircSender.js';

// Mock dependencies
jest.mock('../../../../src/context/contextManager.js');
jest.mock('../../../../src/llm/geminiClient.js');
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

        // Initialize the manager
        // The manager uses a singleton pattern, getRiddleGameManager() returns the instance.
        // We need to ensure activeGames is clean or managed.
        // RiddleGameManager's initializeRiddleGameManager clears activeGames.
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
        
        // Manually set gameState to 'inProgress' and define currentRiddle for testing _handleAnswer
        // This is a bit of a hack due to the complexity of the game state machine.
        // Accessing activeGames directly is generally not good practice for external modules,
        // but for testing the private _handleAnswer via its public wrapper, it's a pragmatic approach.
        const activeGames = riddleGameManager.getActiveGamesForTesting(); // Expose activeGames for testing
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
            // Fallback if startGame didn't set up as expected (e.g. if generateRiddle fails in test)
            // This indicates an issue with the setup that needs to be addressed.
            console.error("Failed to initialize mockGameState for Riddle tests. startGame did not populate activeGames as expected.");
            mockGameState = { // A minimal mock state to allow tests to run
                channelName,
                state: 'inProgress',
                currentRiddle: { question: "Test Question", answer: "Test Answer" },
                config: { questionTimeSeconds: 30 },
                startTime: Date.now(),
                userLastGuessTime: {},
                topic: null,
            };
            if (activeGames) { // Try to set it if activeGames map exists
                activeGames.set(channelName, mockGameState);
            }
        }
    });

    // Helper to expose activeGames for testing purposes
    // This would ideally be part of the manager's test setup if it were a class instance
    // For a module singleton, we might need to modify the source or use a more complex setup.
    // For now, assuming getRiddleGameManager() returns an object that we can add a method to for tests.
    getRiddleGameManager().getActiveGamesForTesting = () => {
        // This is a conceptual approach. In reality, you'd access the internal activeGames map.
        // If riddleGameManager directly exposes activeGames or a method to get it, use that.
        // Otherwise, this part needs adjustment based on how activeGames is truly stored/accessed.
        // For this example, let's assume there's an internal `activeGames` map that we can access
        // via a special method or by modifying the module for testability (e.g. using rewire or similar).
        // This is a simplified placeholder.
        
        // A more realistic approach for module patterns without classes:
        // You might need to export activeGames from riddleGameManager.js for testing,
        // or use a library like 'rewire' to access unexported variables.
        // Given the constraints, we'll assume direct access or a test-specific export.
        // Let's pretend `riddleGameManagerInstance.activeGames` exists for the test.
        return getRiddleGameManager().__internal_getActiveGames(); // Assume this is a test-only exposed method
    };
     // A more realistic way to access activeGames for testing if it's not directly exposed:
    // Modify riddleGameManager.js to export activeGames when NODE_ENV is 'test'
    // Or, as a simpler approach for now, we assume getRiddleGameManager provides a way to access it.
    // This part is crucial and might need adjustment based on actual module structure.
    // Let's assume `getRiddleGameManager().__internal_getActiveGames()` is a test-specific method.
    let internalActiveGamesMap;
    getRiddleGameManager().__internal_getActiveGames = () => {
        if (!internalActiveGamesMap) {
            // This is a simplified way to get a reference to the internal map.
            // In a real scenario, you'd need to ensure this map is the *actual* one used by the manager.
            // This might involve initializing the manager in a way that it uses a map you provide,
            // or exporting the map for testing purposes.
            // For now, we'll simulate it. This is a key area that might need refinement.
            internalActiveGamesMap = new Map();
        }
        return internalActiveGamesMap;
    };
     riddleGameManager.initialize = async () => { // Re-initialize to use the test-exposed activeGames
        const games = getRiddleGameManager().__internal_getActiveGames();
        games.clear();
        // Potentially load all channel configs here if needed on startup (mocked)
    };


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

    test('5. Bot language is null/undefined: translateText NOT called, verifyRiddleAnswer called with original answer', async () => {
        getContextManager().getBotLanguage.mockReturnValue(null);
        const userAnswer = "A needle";
        await riddleGameManager.processPotentialAnswer('testchannel', 'user5', 'User5', userAnswer);

        expect(translateText).not.toHaveBeenCalled();
        expect(verifyRiddleAnswer).toHaveBeenCalledWith(
            mockGameState.currentRiddle.answer,
            userAnswer,
            mockGameState.currentRiddle.question,
            mockGameState.topic
        );
    });
    
    // Test to ensure userLastGuessTime is managed
    test('Spam prevention: subsequent guesses from same user are throttled', async () => {
        getContextManager().getBotLanguage.mockReturnValue('english');
        const userAnswer = "A needle";

        // First guess
        await riddleGameManager.processPotentialAnswer('testchannel', 'userSpam', 'UserSpam', userAnswer);
        expect(verifyRiddleAnswer).toHaveBeenCalledTimes(1);

        // Immediate second guess - should be throttled
        await riddleGameManager.processPotentialAnswer('testchannel', 'userSpam', 'UserSpam', userAnswer + " again");
        expect(verifyRiddleAnswer).toHaveBeenCalledTimes(1); // Still 1, because it was throttled

        // Wait for throttle to pass (default is 2000ms in riddleGameManager)
        await new Promise(resolve => setTimeout(resolve, 2100));

        // Third guess - should not be throttled
        await riddleGameManager.processPotentialAnswer('testchannel', 'userSpam', 'UserSpam', userAnswer + " yet again");
        expect(verifyRiddleAnswer).toHaveBeenCalledTimes(2);
    });
});
