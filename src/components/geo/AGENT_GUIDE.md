# AI Agent Guide: `/src/components/geo` Directory

## 1. Overview

This directory contains all the logic for the "Geo-Game," a geography-based guessing game played in chat.

- **`geoGameManager.js`**: The state machine for the game. It manages the game's flow (starting, stopping, handling guesses, managing rounds) and holds the in-memory state for active games.
- **`geoLocationService.js`**: Interacts with the LLM to select a location for the game and to validate user guesses.
- **`geoClueService.js`**: Interacts with the LLM to generate clues for the selected location.
- **`geoMessageFormatter.js`**: A utility for creating the formatted chat messages sent to the channel during the game (e.g., "Clue #1: ...", "Correct!").
- **`geoStorage.js`**: Handles all persistent storage for the game, including player stats, game history, and channel-specific configurations, using Firestore.
- **`geoPrompts.js`**: Contains the prompt templates used for interacting with the LLM for this feature.

---

## 2. Making Code Changes

### Modifying Game Logic:

-   Changes to the rules of the game (e.g., round duration, number of clues, scoring) should be made in `geoGameManager.js`. Default values are at the top of the file.
-   To change how locations are selected or how guesses are validated, modify the prompts and logic in `geoLocationService.js`.
-   To alter the style or content of the clues, adjust the prompts in `geoClueService.js`.

### Changing Chat Messages:

-   All user-facing text for the game should be modified in `geoMessageFormatter.js` to ensure consistency.

### Data and Storage:

-   If you need to store new information (e.g., a new player statistic), add the relevant fields to the data models in `geoStorage.js` and update the `recordGameResult` or `updatePlayerScore` functions.

---