# AI Agent Guide: `/src/components/commands` Directory

## 1. Overview

This directory is responsible for processing and handling all chat commands (e.g., `!ping`, `!ask`).

- **`commandProcessor.js`**: The core of the command system. It parses incoming messages to identify commands, checks user permissions, and executes the appropriate handler.
- **`handlers/`**: This subdirectory contains the individual logic for each command.

---

## 2. Making Code Changes

### Adding a New Command:

1.  Create a new file in the `handlers/` subdirectory (e.g., `myCommand.js`).
2.  Inside the new file, define an object that includes `name`, `description`, `usage`, `permission` (`everyone`, `moderator`, or `broadcaster`), and an `execute` function.
3.  Import the new handler in `handlers/index.js` and add it to the `commandHandlers` object. The key should be the command name (without the "!").
4.  The `execute` function will receive a `context` object containing `channel`, `user` (tags), `args`, `ircClient`, and `logger`.

### Modifying Command Logic:

-   To change how a specific command behaves, edit the corresponding file in the `handlers/` directory.
-   To change how commands are parsed or how permissions are checked, modify `commandProcessor.js`.
-   **Important**: All replies to the chat should be sent using the `enqueueMessage` function from `src/lib/ircSender.js` to respect rate limits. Do not use `ircClient.say()` directly in handlers.

---