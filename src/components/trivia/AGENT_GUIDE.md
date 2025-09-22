# AI Agent Guide: `/src/components/trivia` Directory

## 1. Overview

This directory contains all the logic for the "Trivia" game feature.

- **`triviaGameManager.js`**: The main controller for the trivia game. It manages the game state (active, idle), handles starting and stopping games, processes user answers, and orchestrates rounds.
- **`triviaQuestionService.js`**: Responsible for interacting with the LLM to generate trivia questions and verify user answers.
- **`triviaMessageFormatter.js`**: A utility for creating consistent, formatted chat messages for the trivia game.
- **`triviaStorage.js`**: Handles all database interactions for trivia, including saving player scores, game history, and channel configurations to Firestore.

---

## 2. Making Code Changes

### Modifying Trivia Game Logic:

-   To change game rules like question time, points awarded, or number of rounds, modify the `DEFAULT_CONFIG` and logic within `triviaGameManager.js`.
-   The prompts used to generate questions and the logic for answer verification are in `triviaQuestionService.js`. To change the style of questions or the strictness of answer checking, modify this file.

### Adding a New Trivia Feature:

1.  Add the core logic to `triviaGameManager.js` (e.g., a new game mode).
2.  If it requires new LLM interactions, add a function to `triviaQuestionService.js`.
3.  Create any new user-facing messages in `triviaMessageFormatter.js`.
4.  If it needs to be stored, update `triviaStorage.js`.
5.  Expose the new feature via the `!trivia` command handler in `src/components/commands/handlers/trivia.js`.

---