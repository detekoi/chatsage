// Geo-Game Message Formatter
// Produces consistently formatted chat messages for the Geo-Game
//
// Each formatter takes a trailing `lang` and returns a plain string — the catalog value when the
// language is catalogued, otherwise the original English template.

import { t } from '../../lib/i18n.js';

/**
 * Formats the start message for a new game session.
 * @param {'real'|'game'} mode
 * @param {string|null} gameTitle - Null if mode is 'real'.
 * @param {number} roundDurationMinutes
 * @param {number} totalRounds - The total number of rounds in this game session.
 * @param {string|null} [regionScope=null] - User-specified region if mode is 'real'.
 * @param {string|null} [lang=null] - Target language for catalog lookup.
 * @returns {string}
 */
export function formatStartMessage(mode, gameTitle = null, roundDurationMinutes = 5, totalRounds = 1, regionScope = null, lang = null) {
    const roundInfo = totalRounds > 1
        ? (t('geo.roundInfo', { totalRounds }, lang) ?? ` (${totalRounds} rounds)`)
        : '';
    const durationInfo = t('geo.durationInfo', { roundDurationMinutes }, lang)
        ?? `You have ⏱️ ${roundDurationMinutes} minutes per round.`;
    if (mode === 'game') {
        const gameTitleText = gameTitle
            ? (t('geo.gameTitleText', { gameTitle }, lang) ?? ` "${gameTitle}"`)
            : '';
        return t('geo.startGame', { roundInfo, gameTitleText, durationInfo }, lang)
            ?? `🎮 Geo-Game started!${roundInfo} Guess the location from the game${gameTitleText}! ${durationInfo} Type your guesses in chat! First clue incoming...`;
    } else {
        // Real mode
        const regionInfo = regionScope
            ? (t('geo.regionInfo', { regionScope }, lang) ?? ` (Region: ${regionScope})`)
            : '';
        return t('geo.startReal', { regionInfo, roundInfo, durationInfo }, lang)
            ?? `🌍 Geo-Game started!${regionInfo}${roundInfo} Guess the real-world city, landmark, or place! ${durationInfo} Type your guesses in chat! First clue incoming...`;
    }
}

/**
 * Formats the message announcing the start of the next round in a multi-round game.
 * @param {number} currentRound - The round number that is starting.
 * @param {number} totalRounds - The total number of rounds.
 * @param {string|null} [lang=null] - Target language for catalog lookup.
 * @returns {string}
 */
export function formatStartNextRoundMessage(currentRound, totalRounds, lang = null) {
    return t('geo.nextRound', { currentRound, totalRounds }, lang)
        ?? `🏁 Round ${currentRound}/${totalRounds} starting now! Good luck!`;
}

/**
 * Formats a clue message.
 * @param {number} clueNumber
 * @param {string} clueText
 * @param {string|null} [lang=null] - Target language for catalog lookup.
 * @returns {string}
 */
export function formatClueMessage(clueNumber, clueText, lang = null) {
    return t('geo.clue', { clueNumber, clueText }, lang)
        ?? `❓ Clue ${clueNumber}: ${clueText}`;
}

/**
 * Formats the message for a correct guess.
 * @param {string} displayName
 * @param {string} locationName
 * @param {number|null} [timeTakenMs]
 * @param {string} [streakInfo=''] - Formatted streak info (e.g., " 🔥x3")
 * @param {string} [pointsInfo=''] - Formatted points info (e.g., " (+25 pts)")
 * @param {string|null} [lang=null] - Target language for catalog lookup.
 * @returns {string}
 */
export function formatCorrectGuessMessage(displayName, locationName, timeTakenMs = null, streakInfo = '', pointsInfo = '', lang = null) {
    let timeMsg = '';
    if (typeof timeTakenMs === 'number' && timeTakenMs > 0) {
        const seconds = Math.round(timeTakenMs / 1000);
        timeMsg = t('common.timeString', { seconds }, lang) ?? ` in ${seconds}s`;
    }
    // Include streak and points info
    return t('geo.correctGuess', { displayName, locationName, timeMsg, streakInfo, pointsInfo }, lang)
        ?? `✅ Congrats @${displayName}! You guessed: ${locationName}${timeMsg}${streakInfo}${pointsInfo}!`;
}

/**
 * Formats the timeout message when the round ends without a correct guess.
 * @param {string} locationName
 * @param {string|null} [lang=null] - Target language for catalog lookup.
 * @returns {string}
 */
export function formatTimeoutMessage(locationName, lang = null) {
    return t('geo.timeout', { locationName }, lang)
        ?? `⏱️ Time's up! The correct answer was: ${locationName}`;
}

/**
 * Formats the message when the game is stopped by a mod/broadcaster.
 * @param {string} [locationName]
 * @param {string|null} [lang=null] - Target language for catalog lookup.
 * @returns {string}
 */
export function formatStopMessage(locationName = null, lang = null) {
    if (locationName) {
        return t('geo.stopWithAnswer', { locationName }, lang)
            ?? `🛑 Geo-Game stopped. The answer was: ${locationName}`;
    } else {
        return t('geo.stop', {}, lang) ?? `🛑 Geo-Game stopped.`;
    }
}

/**
 * Formats the final reveal message with the location and a summary.
 * @param {string} locationName
 * @param {string} revealText
 * @param {string|null} [lang=null] - Target language for catalog lookup.
 * @returns {string}
 */
export function formatRevealMessage(locationName, revealText, lang = null) {
    return t('geo.reveal', { locationName, revealText }, lang)
        ?? `📢 The answer was: ${locationName}! ${revealText}`;
}

/**
 * Formats the game session scores message.
 * @param {Map<string, { displayName: string; score: number }>} gameSessionScores - Map of username -> { displayName, score (points) }.
 * @param {string|null} [lang=null] - Target language for catalog lookup.
 * @returns {string} Formatted score message, or empty string if no scores.
 */
export function formatGameSessionScoresMessage(gameSessionScores, lang = null) {
    if (!gameSessionScores || gameSessionScores.size === 0) {
        return t('geo.noScores', {}, lang) ?? "No scores recorded for this session.";
    }

    // Convert map to array, sort by score descending
    const sortedScores = Array.from(gameSessionScores.entries()).sort(([, a], [, b]) => b.score - a.score);

    // Format top N players (e.g., top 5)
    const topN = 5;
    const listItems = sortedScores.slice(0, topN).map(([username, data], index) => {
        const rank = index + 1;
        const name = data.displayName || username;
        const score = data.score; // score now represents points
        return t('common.scoreEntry', { rank, name, score }, lang)
            ?? `${rank}. ${name} (${score} pts)`; // Label as 'pts'
    });

    if (listItems.length === 0) {
         return t('geo.noScores', {}, lang) ?? "No scores recorded for this session.";
    }

    return t('geo.sessionScores', { list: listItems.join(', ') }, lang)
        ?? `Top Players: ${listItems.join(', ')}`;
}
