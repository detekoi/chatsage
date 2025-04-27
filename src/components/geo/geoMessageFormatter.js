// Geo-Game Message Formatter
// Produces consistently formatted chat messages for the Geo-Game

/**
 * Formats the start message for a new game round.
 * @param {'real'|'game'} mode
 * @param {string|null} gameTitle
 * @param {number} [roundDurationMinutes]
 * @returns {string}
 */
export function formatStartMessage(mode, gameTitle = null, roundDurationMinutes = 5) {
    if (mode === 'game') {
        return `🎮 Geo-Game started! Guess the location from the game${gameTitle ? ` "${gameTitle}"` : ''}! You have ⏱️ ${roundDurationMinutes} minutes. Type your guesses in chat!`;
    } else {
        return `🌍 Geo-Game started! Guess the real-world city, landmark, or place! You have ⏱️ ${roundDurationMinutes} minutes. Type your guesses in chat!`;
    }
}

/**
 * Formats a clue message.
 * @param {number} clueNumber
 * @param {string} clueText
 * @returns {string}
 */
export function formatClueMessage(clueNumber, clueText) {
    return `❓ Clue ${clueNumber}: ${clueText}`;
}

/**
 * Formats the message for a correct guess.
 * @param {string} displayName
 * @param {string} locationName
 * @param {number} [timeTakenMs]
 * @returns {string}
 */
export function formatCorrectGuessMessage(displayName, locationName, timeTakenMs = null) {
    let timeMsg = '';
    if (typeof timeTakenMs === 'number' && timeTakenMs > 0) {
        const seconds = Math.round(timeTakenMs / 1000);
        timeMsg = ` in ${seconds}s`;
    }
    return `✅ Congrats @${displayName}! You correctly guessed: ${locationName}${timeMsg}!`;
}

/**
 * Formats the timeout message when the round ends without a correct guess.
 * @param {string} locationName
 * @returns {string}
 */
export function formatTimeoutMessage(locationName) {
    return `⏱️ Time's up! The correct answer was: ${locationName}`;
}

/**
 * Formats the message when the game is stopped by a mod/broadcaster.
 * @param {string} [locationName]
 * @returns {string}
 */
export function formatStopMessage(locationName = null) {
    if (locationName) {
        return `🛑 Geo-Game stopped. The answer was: ${locationName}`;
    } else {
        return `🛑 Geo-Game stopped.`;
    }
}

/**
 * Formats the final reveal message with the location and a summary.
 * @param {string} locationName
 * @param {string} revealText
 * @returns {string}
 */
export function formatRevealMessage(locationName, revealText) {
    return `📢 The answer was: ${locationName}! ${revealText}`;
}
