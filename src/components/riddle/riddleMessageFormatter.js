// src/components/riddle/riddleMessageFormatter.js
import { removeMarkdownAsterisks } from '../llm/llmUtils.js'; // Assuming you have this utility

export function formatRiddleStartMessage(topic, questionTimeSeconds, totalRounds) {
    const roundText = totalRounds > 1 ? `${totalRounds} rounds` : 'a round';
    const topicText = topic ? `Topic: ${topic}` : "I've got a riddle for you!";
    return `🤔 Starting ${roundText} of Riddles! ${topicText} You have ${questionTimeSeconds} seconds to answer. Type your guesses in chat!`;
}

export function formatRiddleQuestionMessage(roundNumber, totalRounds, question, difficulty, timeSeconds) {
    const roundPrefix = totalRounds > 1 ? `[Riddle ${roundNumber}/${totalRounds}] ` : '';
    // Assuming getDifficultyEmoji is a shared utility or you can implement it here
    // const difficultyEmoji = getDifficultyEmoji(difficulty); 
    const difficultyText = difficulty ? `(${difficulty})` : '';
    const cleanQuestion = removeMarkdownAsterisks(question);
    return `${roundPrefix}❓ RIDDLE ${difficultyText}: ${cleanQuestion} (${timeSeconds}s)`;
}

export function formatRiddleCorrectAnswerMessage(roundPrefix, displayName, answer, explanation, timeString, pointsInfo) {
    const cleanExplanation = removeMarkdownAsterisks(explanation || '');
    const explanationText = cleanExplanation ? ` ${cleanExplanation}` : '';
    return `${roundPrefix}✅ @${displayName} solved it${timeString}${pointsInfo}! The answer is: ${answer}.${explanationText}`;
}

export function formatRiddleTimeoutMessage(roundPrefix, answer, explanation) {
    const cleanExplanation = removeMarkdownAsterisks(explanation || '');
    const explanationText = cleanExplanation ? ` ${cleanExplanation}` : '';
    return `${roundPrefix}⏱️ Time's up! The answer was: ${answer}.${explanationText}`;
}

export function formatRiddleStopMessage(roundPrefix, answer, explanation) {
    const cleanExplanation = removeMarkdownAsterisks(explanation || '');
    const explanationText = cleanExplanation ? ` The answer was: ${answer}. ${cleanExplanation}` : ` The answer was: ${answer}.`;
    return `${roundPrefix}🛑 Riddle game stopped.${explanationText}`;
}

export function formatRiddleSessionScoresMessage(scoresMap) {
    if (!scoresMap || scoresMap.size === 0) {
        return "No scores recorded for this riddle session.";
    }
    const scoresArray = Array.from(scoresMap.entries()).sort(([, a], [, b]) => b.score - a.score);
    const topPlayers = scoresArray.slice(0, 5);
    const listItems = topPlayers.map(([username, data], index) => 
        `${index + 1}. ${data.displayName || username} (${data.score} pts)`
    );
    return `🏁 Riddle Session Top Players: ${listItems.join(', ')}`;
}

export function formatRiddleHelpMessage(isModOrBroadcaster) {
    let helpText = `🤔 Riddle Commands: !riddle (general/current game), !riddle <subject> [<rounds>], !riddle <rounds>, !riddle game [<rounds>]`;
    helpText += `, !riddle leaderboard, !riddle report <reason>`;
    if (isModOrBroadcaster) {
        helpText += `, !riddle stop, !riddle clearleaderboard`;
        helpText += `, !riddle config difficulty <easy|normal|hard> | questiontime <sec> | pointsbase <num> | pointstimebonus <true|false> | pointsdifficultymultiplier <true|false> | scoretracking <true|false> | maxrounds <num> | keywordslimit <num> | rounddelay <ms>`;
        helpText += `, !riddle resetconfig`;
    }
    return helpText;
}

export function formatRiddleLeaderboardMessage(leaderboardData, channelName) {
    if (!leaderboardData || leaderboardData.length === 0) {
        return `No Riddle stats found for #${channelName} yet!`;
    }
    const topPlayers = leaderboardData.slice(0, 5);
    const listItems = topPlayers.map((player, index) => 
        `${index + 1}. ${player.data?.displayName || player.id} (${player.data?.points || 0} pts, ${player.data?.correctAnswers || 0} solved)`
    );
    return `🏆 Riddle Masters in #${channelName}: ${listItems.join(', ')}`;
}