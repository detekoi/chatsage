// Geo-Game Message Formatter
// Produces consistently formatted chat messages for the Geo-Game

/**
 * Formats the start message for a new game session.
 * @param {'real'|'game'} mode
 * @param {string|null} gameTitle - Null if mode is 'real'.
 * @param {number} roundDurationMinutes
 * @param {number} totalRounds - The total number of rounds in this game session.
 * @param {string|null} [regionScope=null] - User-specified region if mode is 'real'.
 * @returns {string}
 */
export function formatStartMessage(mode, gameTitle = null, roundDurationMinutes = 5, totalRounds = 1, regionScope = null) {
    const roundInfo = totalRounds > 1 ? ` (${totalRounds} rounds)` : '';
    const durationInfo = `You have ⏱️ ${roundDurationMinutes} minutes per round.`;
    if (mode === 'game') {
        return `🎮 Geo-Game started!${roundInfo} Guess the location from the game${gameTitle ? ` "${gameTitle}"` : ''}! ${durationInfo} Type your guesses in chat! First clue incoming...`;
    } else {
        // Real mode
        const regionInfo = regionScope ? ` (Region: ${regionScope})` : '';
        return `🌍 Geo-Game started!${regionInfo}${roundInfo} Guess the real-world city, landmark, or place! ${durationInfo} Type your guesses in chat! First clue incoming...`;
    }
}

/**
 * Formats the message announcing the start of the next round in a multi-round game.
 * @param {number} currentRound - The round number that is starting.
 * @param {number} totalRounds - The total number of rounds.
 * @returns {string}
 */
export function formatStartNextRoundMessage(currentRound, totalRounds) {
    return `🏁 Round ${currentRound}/${totalRounds} starting now! Good luck!`;
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

/**
 * Formats the game session scores message.
 * @param {Map<string, { displayName: string; score: number }>} gameSessionScores - Map of username -> { displayName, score }.
 * @returns {string} Formatted score message, or empty string if no scores.
 */
export function formatGameSessionScoresMessage(gameSessionScores) {
    if (!gameSessionScores || gameSessionScores.size === 0) {
        return "No scores recorded for this session.";
    }

    // Convert map to array, sort by score descending
    const sortedScores = Array.from(gameSessionScores.entries()).sort(([, a], [, b]) => b.score - a.score);

    // Format top N players (e.g., top 3 or 5)
    const topN = 5;
    const listItems = sortedScores.slice(0, topN).map(([username, data], index) => {
        const rank = index + 1;
        const name = data.displayName || username;
        const score = data.score;
        return `${rank}. ${name} (${score} points)`;
    });

    if (listItems.length === 0) {
         return "No scores recorded for this session."; // Should ideally not happen if size > 0, but safety check
    }

    return `Top Players: ${listItems.join(', ')}`;
}
