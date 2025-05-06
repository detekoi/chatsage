// src/components/trivia/triviaMessageFormatter.js
import logger from '../../lib/logger.js';
import { removeMarkdownAsterisks } from '../llm/llmUtils.js';

/**
 * Formats the game start announcement message.
 * @param {string} topic - The topic of the trivia game.
 * @param {number} questionTimeSeconds - Time allowed for each question.
 * @param {number} totalRounds - Total number of rounds.
 * @returns {string} Formatted message.
 */
export function formatStartMessage(topic, questionTimeSeconds, totalRounds) {
    const roundText = totalRounds > 1 ? `${totalRounds} rounds` : 'a round';
    return `🎯 Starting ${roundText} of Trivia! Topic: ${topic}. You have ${questionTimeSeconds} seconds to answer each question. Type your answers in chat!`;
}

/**
 * Formats a question message.
 * @param {number} roundNumber - Current round number.
 * @param {number} totalRounds - Total rounds.
 * @param {string} question - The question text.
 * @param {string} difficulty - Question difficulty.
 * @param {number} timeSeconds - Time allowed for the question.
 * @returns {string} Formatted message.
 */
export function formatQuestionMessage(roundNumber, totalRounds, question, difficulty, timeSeconds) {
    const roundPrefix = totalRounds > 1 ? `[Round ${roundNumber}/${totalRounds}] ` : '';
    const difficultyEmoji = getDifficultyEmoji(difficulty);
    
    logger.debug(`[TriviaFormatter] Original question from gameState: "${question}"`);
    const cleanQuestion = removeMarkdownAsterisks(question);
    logger.debug(`[TriviaFormatter] Question after removeMarkdownAsterisks: "${cleanQuestion}"`);

    return `${roundPrefix}${difficultyEmoji} TRIVIA: ${cleanQuestion} (${timeSeconds}s)`;
}

/**
 * Formats a correct answer message.
 * @param {string} roundPrefix - Round prefix (for multi-round games).
 * @param {string} displayName - Display name of the winner.
 * @param {string} answer - The correct answer.
 * @param {string} explanation - Explanation of the answer.
 * @param {string} timeString - Time taken string.
 * @param {string} streakInfo - Streak information.
 * @param {string} pointsInfo - Points information.
 * @returns {string} Formatted message.
 */
export function formatCorrectAnswerMessage(roundPrefix, displayName, answer, explanation, timeString, streakInfo, pointsInfo) {
    const cleanExplanation = removeMarkdownAsterisks(explanation);
    return `${roundPrefix}✅ @${displayName} got it right${timeString}${streakInfo}${pointsInfo}! The answer is: ${answer}. ${cleanExplanation}`;
}

/**
 * Formats a timeout message when no one answers correctly.
 * @param {string} roundPrefix - Round prefix (for multi-round games).
 * @param {string} answer - The correct answer.
 * @param {string} explanation - Explanation of the answer.
 * @returns {string} Formatted message.
 */
export function formatTimeoutMessage(roundPrefix, answer, explanation) {
    const cleanExplanation = removeMarkdownAsterisks(explanation);
    return `${roundPrefix}⏱️ Time's up! The answer is: ${answer}. ${cleanExplanation}`;
}

/**
 * Formats a stop message when the game is manually stopped.
 * @param {string} roundPrefix - Round prefix (for multi-round games).
 * @param {string} answer - The correct answer.
 * @returns {string} Formatted message.
 */
export function formatStopMessage(roundPrefix, answer) {
    return `${roundPrefix}🛑 Game stopped. The answer was: ${answer}`;
}

/**
 * Formats a message announcing the start of the next round.
 * @param {number} roundNumber - Current round number.
 * @param {number} totalRounds - Total rounds.
 * @returns {string} Formatted message.
 */
export function formatStartNextRoundMessage(roundNumber, totalRounds) {
    return `🎮 Starting Round ${roundNumber} of ${totalRounds}...`;
}

/**
 * Formats a game session scores message.
 * @param {Map<string, {displayName: string, score: number}>} scoresMap - Map of player scores.
 * @returns {string} Formatted message.
 */
export function formatGameSessionScoresMessage(scoresMap) {
    if (!scoresMap || scoresMap.size === 0) {
        return "No scores recorded.";
    }
    
    // Convert map to array and sort by score (descending)
    const scoresArray = Array.from(scoresMap, ([username, data]) => ({
        username,
        displayName: data.displayName || username,
        score: data.score || 0
    }));
    
    scoresArray.sort((a, b) => b.score - a.score);
    
    // Format top players (limit to 5 for display)
    const topPlayers = scoresArray.slice(0, 5);
    
    return topPlayers
        .map((player, index) => `${index + 1}. ${player.displayName} (${player.score} pts)`)
        .join(', ');
}

/**
 * Formats help information for the trivia command.
 * @param {boolean} isModOrBroadcaster - Whether the user is a mod or broadcaster.
 * @returns {string} Formatted help message.
 */
export function formatHelpMessage(isModOrBroadcaster) {
    let helpText = `🎮 Trivia Commands: !trivia (starts a general knowledge game), !trivia [topic] [rounds] (specific topic), !trivia game [rounds] (based on current stream game), !trivia leaderboard`;
    
    if (isModOrBroadcaster) {
        helpText += `, !trivia stop, !trivia config <options...>, !trivia resetconfig, !trivia clearleaderboard`;
    } else {
        helpText += `. Mods can use additional commands.`;
    }
    
    return helpText;
}

/**
 * Gets an emoji representing the difficulty level.
 * @param {string} difficulty - Difficulty level.
 * @returns {string} Emoji representing the difficulty.
 */
function getDifficultyEmoji(difficulty) {
    switch (difficulty?.toLowerCase()) {
        case 'easy':
            return '🟢';
        case 'normal':
            return '🟡';
        case 'hard':
            return '🔴';
        default:
            return '❓';
    }
}