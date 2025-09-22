# AI Agent Guide: `/src/components/commands/handlers` Directory

## 1. Overview

This directory contains the implementation for each individual chat command. Each file represents a command (or a group of related commands) and exports a handler object.

- **`index.js`**: This file aggregates all handlers and exports them as a single `commandHandlers` object. It also defines command aliases (e.g., mapping `!sage` to the `!ask` handler).
- **Command Files (e.g., `ping.js`, `ask.js`)**: Each file defines the logic for a command, including its permissions and `execute` function.

---

## 2. Making Code Changes

### Creating a New Command Handler:

1.  Create a new file (e.g., `newCmd.js`).
2.  Define the handler object:
    ```javascript
    export default {
      name: 'newCmd',
      description: 'A brief description of what the command does.',
      usage: '!newCmd [arguments]',
      permission: 'everyone', // or 'moderator', 'broadcaster'
      execute: async (context) => {
        const { channel, user, args, replyToId } = context;
        // Your command logic here
        // Use enqueueMessage(channel, 'My response', { replyToId }); to reply
      },
    };
    ```
3.  Import and add your new handler to `index.js`. If the command has aliases, add them in `index.js` as well.

### Modifying an Existing Command:

-   Locate the file corresponding to the command you wish to change.
-   Modify the `execute` function to alter its behavior.
-   You can access shared services like the `contextManager` or `geminiClient` by importing their `get...` functions.

### Best Practices:

-   Keep each handler file focused on a single command.
-   For complex commands (like the games), the handler should act as a controller, calling methods from a dedicated manager in another directory (e.g., `!trivia` calls `getTriviaGameManager()`).
-   Always use `enqueueMessage` for sending messages to avoid IRC rate limit issues.

---