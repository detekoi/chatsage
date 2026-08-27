// src/components/trivia/triviaMessageFormatter.js
import logger from '../../lib/logger.js';
import { removeMarkdownAsterisks } from '../llm/llmUtils.js';
import { t } from '../../lib/i18n.js';

// Every formatter takes a trailing `lang` (locale code or English language name) and returns a
// plain string: the catalog value when one exists, otherwise the original English template.
// Plain strings — not deferred objects — because callers concatenate these results and measure
// their .length before summarizing (see triviaGameManager._endRound).

/**
 * Formats the "a round" / "N rounds" fragment. Kept as its own key so the surrounding sentence
 * is not left with an English fragment spliced into it.
 * @param {number} totalRounds
 * @param {string|null} lang
 * @returns {string}
 */
function formatRoundText(totalRounds, lang = null) {
    return totalRounds > 1
        ? (t('common.roundText.many', { totalRounds }, lang) ?? `${totalRounds} rounds`)
        : (t('common.roundText.one', {}, lang) ?? 'a round');
}

/**
 * Formats the game start announcement message.
 * @param {string} topic - The topic of the trivia game.
 * @param {number} questionTimeSeconds - Time allowed for each question.
 * @param {number} totalRounds - Total number of rounds.
 * @param {string|null} [lang=null] - Target language for catalog lookup.
 * @returns {string} Formatted message.
 */
export function formatStartMessage(topic, questionTimeSeconds, totalRounds, lang = null) {
    const roundText = formatRoundText(totalRounds, lang);
    return t('trivia.start', { roundText, topic, questionTimeSeconds }, lang)
        ?? `🎯 Starting ${roundText} of Trivia! Topic: ${topic}. You have ${questionTimeSeconds} seconds to answer each question. Type your answers in chat!`;
}

/**
 * Formats a question message.
 * @param {number} roundNumber - Current round number.
 * @param {number} totalRounds - Total rounds.
 * @param {string} question - The question text.
 * @param {string} difficulty - Question difficulty.
 * @param {number} timeSeconds - Time allowed for the question.
 * @param {string|null} [lang=null] - Target language for catalog lookup.
 * @returns {string} Formatted message.
 */
export function formatQuestionMessage(roundNumber, totalRounds, question, difficulty, timeSeconds, lang = null) {
    const roundPrefix = totalRounds > 1
        ? (t('trivia.roundPrefix', { roundNumber, totalRounds }, lang) ?? `[Round ${roundNumber}/${totalRounds}] `)
        : '';
    const difficultyEmoji = getDifficultyEmoji(difficulty);

    logger.debug(`[TriviaFormatter] Original question from gameState: "${question}"`);
    const cleanQuestion = removeMarkdownAsterisks(question);
    logger.debug(`[TriviaFormatter] Question after removeMarkdownAsterisks: "${cleanQuestion}"`);

    return t('trivia.question', { roundPrefix, difficultyEmoji, question: cleanQuestion, timeSeconds }, lang)
        ?? `${roundPrefix}${difficultyEmoji} TRIVIA: ${cleanQuestion} (${timeSeconds}s)`;
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
 * @param {string|null} [lang=null] - Target language for catalog lookup.
 * @returns {string} Formatted message.
 */
export function formatCorrectAnswerMessage(roundPrefix, displayName, answer, explanation, timeString, streakInfo, pointsInfo, lang = null) {
    const cleanExplanation = removeMarkdownAsterisks(explanation);
    return t('trivia.correctAnswer', { roundPrefix, displayName, answer, explanation: cleanExplanation, timeString, streakInfo, pointsInfo }, lang)
        ?? `${roundPrefix}✅ @${displayName} got it right${timeString}${streakInfo}${pointsInfo}! The answer is: ${answer}. ${cleanExplanation}`;
}

/**
 * Formats a timeout message when no one answers correctly.
 * @param {string} roundPrefix - Round prefix (for multi-round games).
 * @param {string} answer - The correct answer.
 * @param {string} explanation - Explanation of the answer.
 * @param {string|null} [lang=null] - Target language for catalog lookup.
 * @returns {string} Formatted message.
 */
export function formatTimeoutMessage(roundPrefix, answer, explanation, lang = null) {
    const cleanExplanation = removeMarkdownAsterisks(explanation);
    return t('trivia.timeout', { roundPrefix, answer, explanation: cleanExplanation }, lang)
        ?? `${roundPrefix}⏱️ Time's up! The answer is: ${answer}. ${cleanExplanation}`;
}

/**
 * Formats a stop message when the game is manually stopped.
 * @param {string} roundPrefix - Round prefix (for multi-round games).
 * @param {string} answer - The correct answer.
 * @param {string|null} [lang=null] - Target language for catalog lookup.
 * @returns {string} Formatted message.
 */
export function formatStopMessage(roundPrefix, answer, lang = null) {
    return t('trivia.stop', { roundPrefix, answer }, lang)
        ?? `${roundPrefix}🛑 Game stopped. The answer was: ${answer}`;
}

/**
 * Formats a message announcing the start of the next round.
 * @param {number} roundNumber - Current round number.
 * @param {number} totalRounds - Total rounds.
 * @param {string|null} [lang=null] - Target language for catalog lookup.
 * @returns {string} Formatted message.
 */
export function formatStartNextRoundMessage(roundNumber, totalRounds, lang = null) {
    return t('trivia.nextRound', { roundNumber, totalRounds }, lang)
        ?? `🎮 Starting Round ${roundNumber} of ${totalRounds}...`;
}

/**
 * Formats a game session scores message.
 * @param {Map<string, {displayName: string, score: number}>} scoresMap - Map of player scores.
 * @param {string|null} [lang=null] - Target language for catalog lookup.
 * @returns {string} Formatted message.
 */
export function formatGameSessionScoresMessage(scoresMap, lang = null) {
    if (!scoresMap || scoresMap.size === 0) {
        return t('trivia.noScores', {}, lang) ?? "No scores recorded.";
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
        .map((player, index) => {
            const rank = index + 1;
            return t('common.scoreEntry', { rank, name: player.displayName, score: player.score }, lang)
                ?? `${rank}. ${player.displayName} (${player.score} pts)`;
        })
        .join(', ');
}

/**
 * Formats help information for the trivia command.
 * @param {boolean} isModOrBroadcaster - Whether the user is a mod or broadcaster.
 * @param {string|null} [lang=null] - Target language for catalog lookup.
 * @returns {string} Formatted help message.
 */
export function formatHelpMessage(isModOrBroadcaster, lang = null) {
    let helpText = t('trivia.help.base', {}, lang)
        ?? `🎮 Trivia Commands: !trivia (starts a general knowledge game), !trivia [topic] [rounds] (specific topic), !trivia game [rounds] (based on current stream game), !trivia leaderboard`;

    if (isModOrBroadcaster) {
        helpText += t('trivia.help.mod', {}, lang)
            ?? `, !trivia stop, !trivia config <options...>, !trivia resetconfig, !trivia clearleaderboard`;
    } else {
        helpText += t('trivia.help.nonMod', {}, lang) ?? `. Mods can use additional commands.`;
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
