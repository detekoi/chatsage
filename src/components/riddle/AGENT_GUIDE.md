# AI Agent Guide: `/src/components/riddle` Directory

## 1. Overview

This directory contains all the logic for the "Riddle" game feature. It is structured similarly to the Trivia and Geo-Game components.

- **`riddleGameManager.js`**: Manages the state and flow of the riddle game. It handles starting/stopping, processing answers, and managing rounds.
- **`riddleService.js`**: Interacts with the LLM to generate creative, metaphorical riddles and to verify user answers against the correct solution.
- **`riddleMessageFormatter.js`**: Formats all chat messages related to the riddle game for consistency.
- **`riddleStorage.js`**: Manages persistent storage of riddle game data, such as player scores, game history, and configurations, in Firestore.

---

## 2. Making Code Changes

### Modifying Riddle Game Logic:

-   Changes to game rules (e.g., time limits, scoring) should be implemented in `riddleGameManager.js`.
-   To adjust the style, difficulty, or creativity of the riddles, modify the LLM prompts within `riddleService.js`. The `generateRiddle` function is the primary target.
-   The logic for checking if a user's guess is correct is handled in `verifyRiddleAnswer` within `riddleService.js`.

### Adding a New Riddle Feature:

1.  Implement the core feature logic in `riddleGameManager.js`.
2.  If new LLM interactions are needed, add corresponding functions to `riddleService.js`.
3.  Define any new chat messages in `riddleMessageFormatter.js`.
4.  Update `riddleStorage.js` if new data needs to be saved.
5.  Expose the feature through the `!riddle` command handler.

---