// src/locales/en.js
// Source of truth. Edit this file, then run: node scripts/translate-catalog.js

export default {
    "common": {
        "timeString": " in {seconds}s",
        "streakInfo": " 🔥x{streak}",
        "pointsInfo": " (+{points} pts)",
        "scoreEntry": "{rank}. {name} ({score} pts)",
        "roundText": {
            "one": "a round",
            "many": "{totalRounds} rounds"
        },
        "roundPrefixParen": "(Round {currentRound}/{totalRounds}) "
    },
    "trivia": {
        "start": "🎯 Starting {roundText} of Trivia! Topic: {topic}. You have {questionTimeSeconds} seconds to answer each question. Type your answers in chat!",
        "roundPrefix": "[Round {roundNumber}/{totalRounds}] ",
        "question": "{roundPrefix}{difficultyEmoji} TRIVIA: {question} ({timeSeconds}s)",
        "correctAnswer": "{roundPrefix}✅ @{displayName} got it right{timeString}{streakInfo}{pointsInfo}! The answer is: {answer}. {explanation}",
        "timeout": "{roundPrefix}⏱️ Time's up! The answer is: {answer}. {explanation}",
        "stop": "{roundPrefix}🛑 Game stopped. The answer was: {answer}",
        "nextRound": "🎮 Starting Round {roundNumber} of {totalRounds}...",
        "noScores": "No scores recorded.",
        "help": {
            "base": "🎮 Trivia Commands: !trivia (starts a general knowledge game), !trivia [topic] [rounds] (specific topic), !trivia game [rounds] (based on current stream game), !trivia leaderboard",
            "mod": ", !trivia stop, !trivia config <options...>, !trivia resetconfig, !trivia clearleaderboard",
            "nonMod": ". Mods can use additional commands."
        },
        "gameStoppedScores": "🏁 Game stopped. Final Scores: {list}",
        "finalScores": "🏁 Final Scores: {list}"
    },
    "riddle": {
        "start": "🤔 Starting {roundText} of Riddles! {topicText} You have {questionTimeSeconds} seconds to answer. Type your guesses in chat!",
        "topicText": "Topic: {topic}",
        "noTopicText": "I've got a riddle for you!",
        "roundPrefix": "[Riddle {roundNumber}/{totalRounds}] ",
        "question": "{roundPrefix}❓ RIDDLE: {question} ({timeSeconds}s)",
        "correctAnswer": "{roundPrefix}✅ @{displayName} solved it{timeString}{pointsInfo}! The answer is: {answer}.{explanationText}",
        "timeout": "{roundPrefix}⏱️ Time's up! The answer was: {answer}.{explanationText}",
        "stop": "{roundPrefix}🛑 Riddle game stopped.{explanationText}",
        "stopExplanation": " The answer was: {answer}. {explanation}",
        "stopAnswerOnly": " The answer was: {answer}.",
        "noScores": "No scores recorded for this riddle session.",
        "sessionScores": "🏁 Riddle Session Top Players: {list}",
        "noLeaderboard": "No Riddle stats found for #{channelName} yet!",
        "leaderboard": "🏆 Riddle Masters in #{channelName}: {list}",
        "leaderboardEntry": "{rank}. {name} ({points} pts, {solved} solved)",
        "help": {
            "base": "🤔 Riddle Commands: !riddle (general/current game), !riddle <subject> [<rounds>], !riddle <rounds>, !riddle game [<rounds>]",
            "common": ", !riddle leaderboard, !riddle report <reason>",
            "modStop": ", !riddle stop, !riddle clearleaderboard",
            "modConfig": ", !riddle config difficulty <easy|normal|hard> | questiontime <sec> | pointsbase <num> | pointstimebonus <true|false> | pointsdifficultymultiplier <true|false> | scoretracking <true|false> | maxrounds <num> | keywordslimit <num> | rounddelay <ms>",
            "modReset": ", !riddle resetconfig"
        },
        "gameOver": "{roundPrefix}The riddle is over. The answer was: {answer}. {explanation}"
    },
    "geo": {
        "startGame": "🎮 Geo-Game started!{roundInfo} Guess the location from the game{gameTitleText}! {durationInfo} Type your guesses in chat! First clue incoming...",
        "startReal": "🌍 Geo-Game started!{regionInfo}{roundInfo} Guess the real-world city, landmark, or place! {durationInfo} Type your guesses in chat! First clue incoming...",
        "roundInfo": " ({totalRounds} rounds)",
        "durationInfo": "You have ⏱️ {roundDurationMinutes} minutes per round.",
        "gameTitleText": " \"{gameTitle}\"",
        "regionInfo": " (Region: {regionScope})",
        "nextRound": "🏁 Round {currentRound}/{totalRounds} starting now! Good luck!",
        "clue": "❓ Clue {clueNumber}: {clueText}",
        "correctGuess": "✅ Congrats @{displayName}! You guessed: {locationName}{timeMsg}{streakInfo}{pointsInfo}!",
        "timeout": "⏱️ Time's up! The correct answer was: {locationName}",
        "stopWithAnswer": "🛑 Geo-Game stopped. The answer was: {locationName}",
        "stop": "🛑 Geo-Game stopped.",
        "reveal": "📢 The answer was: {locationName}! {revealText}",
        "noScores": "No scores recorded for this session.",
        "sessionScores": "Top Players: {list}",
        "gameEndedScores": "🏁 Game ended. Final Session Scores: {list}",
        "finalScores": "🏁 Final Session Scores: {list}",
        "summaryPrefix": {
            "guessed": "{roundPrefix}✅ @{displayName} guessed: {locationName}{timeString}{streakInfo}{pointsInfo}! ",
            "timeout": "{roundPrefix}⏱️ Time's up! The location was {locationName}. ",
            "stopped": "{roundPrefix}🛑 Game stopped. The location was {locationName}. ",
            "reveal": "{roundPrefix}📢 The answer was: {locationName}! "
        },
        "roundError": "An error occurred revealing the answer for round {currentRound}.",
        "roundEnded": "The round has ended."
    }
};
