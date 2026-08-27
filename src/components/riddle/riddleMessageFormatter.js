// src/components/riddle/riddleMessageFormatter.js
import { removeMarkdownAsterisks } from '../llm/llmUtils.js';
import { t } from '../../lib/i18n.js';

// Each formatter takes a trailing `lang` and returns a plain string — the catalog value if the
// language is catalogued, otherwise the original English template.

export function formatRiddleStartMessage(topic, questionTimeSeconds, totalRounds, lang = null) {
    const roundText = totalRounds > 1
        ? (t('common.roundText.many', { totalRounds }, lang) ?? `${totalRounds} rounds`)
        : (t('common.roundText.one', {}, lang) ?? 'a round');
    const topicText = topic
        ? (t('riddle.topicText', { topic }, lang) ?? `Topic: ${topic}`)
        : (t('riddle.noTopicText', {}, lang) ?? "I've got a riddle for you!");
    return t('riddle.start', { roundText, topicText, questionTimeSeconds }, lang)
        ?? `🤔 Starting ${roundText} of Riddles! ${topicText} You have ${questionTimeSeconds} seconds to answer. Type your guesses in chat!`;
}

export function formatRiddleQuestionMessage(roundNumber, totalRounds, question, difficulty, timeSeconds, lang = null) {
    const roundPrefix = totalRounds > 1
        ? (t('riddle.roundPrefix', { roundNumber, totalRounds }, lang) ?? `[Riddle ${roundNumber}/${totalRounds}] `)
        : '';
    const cleanQuestion = removeMarkdownAsterisks(question);
    return t('riddle.question', { roundPrefix, question: cleanQuestion, timeSeconds }, lang)
        ?? `${roundPrefix}❓ RIDDLE: ${cleanQuestion} (${timeSeconds}s)`;
}

export function formatRiddleCorrectAnswerMessage(roundPrefix, displayName, answer, explanation, timeString, pointsInfo, lang = null) {
    const cleanExplanation = removeMarkdownAsterisks(explanation || '');
    const explanationText = cleanExplanation ? ` ${cleanExplanation}` : '';
    return t('riddle.correctAnswer', { roundPrefix, displayName, answer, timeString, pointsInfo, explanationText }, lang)
        ?? `${roundPrefix}✅ @${displayName} solved it${timeString}${pointsInfo}! The answer is: ${answer}.${explanationText}`;
}

export function formatRiddleTimeoutMessage(roundPrefix, answer, explanation, lang = null) {
    const cleanExplanation = removeMarkdownAsterisks(explanation || '');
    const explanationText = cleanExplanation ? ` ${cleanExplanation}` : '';
    return t('riddle.timeout', { roundPrefix, answer, explanationText }, lang)
        ?? `${roundPrefix}⏱️ Time's up! The answer was: ${answer}.${explanationText}`;
}

export function formatRiddleStopMessage(roundPrefix, answer, explanation, lang = null) {
    const cleanExplanation = removeMarkdownAsterisks(explanation || '');
    const explanationText = cleanExplanation
        ? (t('riddle.stopExplanation', { answer, explanation: cleanExplanation }, lang) ?? ` The answer was: ${answer}. ${cleanExplanation}`)
        : (t('riddle.stopAnswerOnly', { answer }, lang) ?? ` The answer was: ${answer}.`);
    return t('riddle.stop', { roundPrefix, explanationText }, lang)
        ?? `${roundPrefix}🛑 Riddle game stopped.${explanationText}`;
}

export function formatRiddleSessionScoresMessage(scoresMap, lang = null) {
    if (!scoresMap || scoresMap.size === 0) {
        return t('riddle.noScores', {}, lang) ?? "No scores recorded for this riddle session.";
    }
    const scoresArray = Array.from(scoresMap.entries()).sort(([, a], [, b]) => b.score - a.score);
    const topPlayers = scoresArray.slice(0, 5);
    const listItems = topPlayers.map(([username, data], index) => {
        const rank = index + 1;
        const name = data.displayName || username;
        return t('common.scoreEntry', { rank, name, score: data.score }, lang)
            ?? `${rank}. ${name} (${data.score} pts)`;
    });
    return t('riddle.sessionScores', { list: listItems.join(', ') }, lang)
        ?? `🏁 Riddle Session Top Players: ${listItems.join(', ')}`;
}

export function formatRiddleHelpMessage(isModOrBroadcaster, lang = null) {
    let helpText = t('riddle.help.base', {}, lang)
        ?? `🤔 Riddle Commands: !riddle (general/current game), !riddle <subject> [<rounds>], !riddle <rounds>, !riddle game [<rounds>]`;
    helpText += t('riddle.help.common', {}, lang) ?? `, !riddle leaderboard, !riddle report <reason>`;
    if (isModOrBroadcaster) {
        helpText += t('riddle.help.modStop', {}, lang) ?? `, !riddle stop, !riddle clearleaderboard`;
        helpText += t('riddle.help.modConfig', {}, lang) ?? `, !riddle config difficulty <easy|normal|hard> | questiontime <sec> | pointsbase <num> | pointstimebonus <true|false> | pointsdifficultymultiplier <true|false> | scoretracking <true|false> | maxrounds <num> | keywordslimit <num> | rounddelay <ms>`;
        helpText += t('riddle.help.modReset', {}, lang) ?? `, !riddle resetconfig`;
    }
    return helpText;
}

export function formatRiddleLeaderboardMessage(leaderboardData, channelName, lang = null) {
    if (!leaderboardData || leaderboardData.length === 0) {
        return t('riddle.noLeaderboard', { channelName }, lang) ?? `No Riddle stats found for #${channelName} yet!`;
    }
    const topPlayers = leaderboardData.slice(0, 5);
    const listItems = topPlayers.map((player, index) => {
        const pts = player.data?.channelPoints ?? player.data?.points ?? 0;
        const solved = player.data?.channelSuccesses ?? player.data?.successes ?? 0;
        const rank = index + 1;
        const name = player.data?.displayName || player.id;
        return t('riddle.leaderboardEntry', { rank, name, points: pts, solved }, lang)
            ?? `${rank}. ${name} (${pts} pts, ${solved} solved)`;
    });
    return t('riddle.leaderboard', { channelName, list: listItems.join(', ') }, lang)
        ?? `🏆 Riddle Masters in #${channelName}: ${listItems.join(', ')}`;
}
