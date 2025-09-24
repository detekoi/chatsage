// tests/unit/components/trivia/triviaGameManager.test.js
import { getTriviaGameManager } from '../../../../src/components/trivia/triviaGameManager.js';
import { getContextManager } from '../../../../src/components/context/contextManager.js';
import { translateText } from '../../../../src/lib/translationUtils.js';
import { verifyAnswer } from '../../../../src/components/trivia/triviaQuestionService.js';
import logger from '../../../../src/lib/logger.js';
import { enqueueMessage } from '../../../../src/lib/ircSender.js';

// Mock dependencies
jest.mock('../../../../src/components/context/contextManager.js');
jest.mock('../../../../src/components/llm/geminiClient.js');
jest.mock('../../../../src/components/trivia/triviaQuestionService.js');
jest.mock('../../../../src/lib/logger.js');
jest.mock('../../../../src/lib/ircSender.js');

// Mock triviaStorage functions
jest.mock('../../../../src/components/trivia/triviaStorage.js', () => ({
    loadChannelConfig: jest.fn().mockResolvedValue({}),
    saveChannelConfig: jest.fn().mockResolvedValue(),
    recordGameResult: jest.fn().mockResolvedValue(),
    updatePlayerScore: jest.fn().mockResolvedValue(),
    getRecentQuestions: jest.fn().mockResolvedValue([]),
    getLeaderboard: jest.fn().mockResolvedValue([]),
    clearChannelLeaderboardData: jest.fn().mockResolvedValue({ success: true, message: "Leaderboard cleared." }),
    getLatestCompletedSessionInfo: jest.fn().mockResolvedValue(null),
    flagTriviaQuestionProblem: jest.fn().mockResolvedValue(),
    flagTriviaQuestionByDocId: jest.fn().mockResolvedValue(),
}));


describe('TriviaGameManager - _handleAnswer (via processPotentialAnswer)', () => {
    let triviaGameManager;
    let mockGameState;
    let internalActiveGamesTriviaMap;

    beforeEach(async () => {
        jest.clearAllMocks();

        internalActiveGamesTriviaMap = new Map();
        triviaGameManager = getTriviaGameManager();

        // Test-specific adaptation for initialize and accessing activeGames
        triviaGameManager.initialize = async () => {
            internalActiveGamesTriviaMap.clear();
            // if originalInitializeTrivia did more, mock/replicate here
        };
        triviaGameManager.getActiveGamesForTesting = () => internalActiveGamesTriviaMap;

        await triviaGameManager.initialize();

        getContextManager.mockReturnValue({
            getBotLanguage: jest.fn().mockReturnValue('english'), // Default to English
        });

        verifyAnswer.mockResolvedValue({ is_correct: false });
        
        logger.debug = jest.fn();
        logger.info = jest.fn();
        logger.warn = jest.fn();
        logger.error = jest.fn();
        enqueueMessage.mockClear();

        // Setup: Start a game to make _handleAnswer reachable
        const channelName = 'testtriviachannel';

        // Mock generateQuestion for startGame to succeed
        const { generateQuestion: originalGenerateQuestion } = jest.requireActual('../../../../src/components/trivia/triviaQuestionService.js');
        const mockGenerateQuestion = jest.fn().mockResolvedValue({
            question: "What is the capital of France?",
            answer: "Paris",
            alternateAnswers: [],
            explanation: "Paris is the capital.",
            difficulty: "easy",
            topic: "geography"
        });
        // Use jest.spyOn for the service that is partially mocked and partially used by other tests/code.
        const triviaQuestionService = require('../../../../src/components/trivia/triviaQuestionService.js');
        jest.spyOn(triviaQuestionService, 'generateQuestion').mockImplementation(mockGenerateQuestion);


        await triviaGameManager.startGame(channelName, null, 'testuser', 1);
        
        const activeGames = triviaGameManager.getActiveGamesForTesting();
        if (activeGames && activeGames.has(channelName)) {
            mockGameState = activeGames.get(channelName);
            mockGameState.state = 'inProgress'; // Ensure game is in progress
            mockGameState.currentQuestion = { // Ensure there's a question
                question: "What is the capital of France?",
                answer: "Paris",
                alternateAnswers: [],
                difficulty: "easy",
                topic: "geography"
            };
            mockGameState.startTime = Date.now();
            mockGameState.lastMessageTimestamp = 0; // Reset for throttling
            mockGameState.config = { // Ensure config is present
                 ...mockGameState.config,
                questionTimeSeconds: 30,
                scoreTracking: true,
                pointsBase: 10,
                pointsTimeBonus: true,
                pointsDifficultyMultiplier: true,
            };
        } else {
             console.error("Failed to initialize mockGameState for Trivia tests. startGame did not populate activeGames as expected.");
             mockGameState = {
                channelName,
                state: 'inProgress',
                currentQuestion: { question: "Test Q", answer: "Test A", alternateAnswers: [] },
                config: { questionTimeSeconds: 30, scoreTracking:true, pointsBase:10, pointsTimeBonus:true, pointsDifficultyMultiplier:true },
                startTime: Date.now(),
                lastMessageTimestamp: 0,
                answers: [],
                streakMap: new Map(),
             };
             if(activeGames) activeGames.set(channelName, mockGameState);
        }
        // Restore original generateQuestion
        jest.spyOn(triviaQuestionService, 'generateQuestion').mockImplementation(originalGenerateQuestion);
    });

    test('1. Bot language is English: translateText NOT called, verifyAnswer called with original answer', async () => {
        getContextManager().getBotLanguage.mockReturnValue('english');
        const userAnswer = "Paris";
        triviaGameManager.processPotentialAnswer('testtriviachannel', 'user1', 'User1', userAnswer);
        await new Promise(process.nextTick);


        expect(translateText).not.toHaveBeenCalled();
        expect(verifyAnswer).toHaveBeenCalledWith(
            mockGameState.currentQuestion.answer,
            userAnswer,
            mockGameState.currentQuestion.alternateAnswers,
            mockGameState.currentQuestion.question
        );
    });

    test('2. Bot language is Spanish (translation success): translateText called, verifyAnswer called with translated answer', async () => {
        getContextManager().getBotLanguage.mockReturnValue('spanish');
        const userAnswer = "París";
        const translatedAnswer = "Paris";
        translateText.mockResolvedValue(translatedAnswer);

        triviaGameManager.processPotentialAnswer('testtriviachannel', 'user2', 'User2', userAnswer);
        await new Promise(process.nextTick);

        expect(translateText).toHaveBeenCalledWith(userAnswer, 'English');
        expect(verifyAnswer).toHaveBeenCalledWith(
            mockGameState.currentQuestion.answer,
            translatedAnswer,
            mockGameState.currentQuestion.alternateAnswers,
            mockGameState.currentQuestion.question
        );
    });

    test('3. Bot language is French (translation fails - API error): translateText called, verifyAnswer called with original answer, logs error', async () => {
        getContextManager().getBotLanguage.mockReturnValue('french');
        const userAnswer = "Paris";
        translateText.mockRejectedValue(new Error("Translation API error"));

        triviaGameManager.processPotentialAnswer('testtriviachannel', 'user3', 'User3', userAnswer);
        await new Promise(process.nextTick);

        expect(translateText).toHaveBeenCalledWith(userAnswer, 'English');
        expect(verifyAnswer).toHaveBeenCalledWith(
            mockGameState.currentQuestion.answer,
            userAnswer, // Fallback to original
            mockGameState.currentQuestion.alternateAnswers,
            mockGameState.currentQuestion.question
        );
        expect(logger.error).toHaveBeenCalled();
    });

    test('4. Bot language is German (translation returns empty string): translateText called, verifyAnswer called with original answer, logs warning', async () => {
        getContextManager().getBotLanguage.mockReturnValue('german');
        const userAnswer = "Paris";
        translateText.mockResolvedValue("  "); // Empty or whitespace

        triviaGameManager.processPotentialAnswer('testtriviachannel', 'user4', 'User4', userAnswer);
        await new Promise(process.nextTick);

        expect(translateText).toHaveBeenCalledWith(userAnswer, 'English');
        expect(verifyAnswer).toHaveBeenCalledWith(
            mockGameState.currentQuestion.answer,
            userAnswer, // Fallback to original
            mockGameState.currentQuestion.alternateAnswers,
            mockGameState.currentQuestion.question
        );
        expect(logger.warn).toHaveBeenCalled();
    });
    
    // Test to ensure basic answer processing and throttling
    test('Throttling: subsequent answers from same user are throttled', async () => {
        getContextManager().getBotLanguage.mockReturnValue('english');
        const userAnswer = "Some Answer";

        // First answer
        triviaGameManager.processPotentialAnswer('testtriviachannel', 'userTriviaSpam', 'UserTriviaSpam', userAnswer);
        await new Promise(process.nextTick);
        expect(verifyAnswer).toHaveBeenCalledTimes(1);
        mockGameState.lastMessageTimestamp = Date.now(); // Simulate update

        // Immediate second answer
        triviaGameManager.processPotentialAnswer('testtriviachannel', 'userTriviaSpam', 'UserTriviaSpam', userAnswer + " again");
        await new Promise(process.nextTick);
        expect(verifyAnswer).toHaveBeenCalledTimes(1); // Should be throttled

        // Wait for throttle (500ms in triviaGameManager)
        mockGameState.lastMessageTimestamp = Date.now() - 1000; // Simulate time has passed

        // Third answer
        triviaGameManager.processPotentialAnswer('testtriviachannel', 'userTriviaSpam', 'UserTriviaSpam', userAnswer + " yet again");
        await new Promise(process.nextTick);
        expect(verifyAnswer).toHaveBeenCalledTimes(2);
    });
});
