# AI Agent Guide: `/src` Directory

## 1. Overview

This is the main application source directory. It contains the core logic for the ChatSage bot, organized into subdirectories representing different features and components.

- **`bot.js`**: The main entry point of the application. It initializes all modules, sets up the IRC client, and handles the main event loop.
- **`components/`**: Contains all the modular features of the bot, such as command handlers, game logic (Trivia, Geo-Guessing), and context management.
- **`config/`**: Handles loading and exporting application configuration from environment variables.
- **`lib/`**: Contains shared utility libraries used across the application, such as the logger, IRC message sender, and Secret Manager client.

---

## 2. Making Code Changes

### Adding a New Component:

1.  Create a new subdirectory inside `src/components/`.
2.  Develop the component's logic within its own files.
3.  Import and initialize the new component in `bot.js`.
4.  Ensure the new component is properly integrated into the bot's lifecycle (e.g., connected to the IRC client, context manager, etc.).

### Modifying Core Logic:

-   Changes to the bot's startup or shutdown sequence should be made in `bot.js`.
-   Be mindful of the initialization order in `bot.js`, as many modules depend on others being available.
-   Modifications to shared utilities should be done in `src/lib/` and tested to ensure they don't break other components.

### Style and Conventions:

-   Follow the existing ES module syntax (`import`/`export`).
-   Use the centralized `logger` from `src/lib/logger.js` for all logging. Do not use `console.log`.
-   All asynchronous operations should use `async/await`.

---