# AI Agent Guide: `/src/components/context` Directory

## 1. Overview

This directory is crucial for managing the state and context of the bot's interactions in each channel. It acts as the bot's short-term and long-term memory.

- **`contextManager.js`**: The central hub for in-memory state. It stores chat history, stream information (game, title), and user-specific states (like translation settings). It's responsible for providing a consolidated context to the LLM.
- **`summarizer.js`**: A utility called by the `contextManager` to summarize long chat histories, keeping the context provided to the LLM concise and relevant.
- **`languageStorage.js`**: Manages persistent storage of channel-specific language preferences in Firestore.
- **`commandStateManager.js` & `channelCommandsStorage.js`**: Together, these manage which commands are enabled or disabled in a channel, persisting the settings in Firestore.
- **`autoChatStorage.js`**: Manages the configuration for the auto-chat feature, stored in Firestore.

---

## 2. Making Code Changes

### Modifying State Management:

-   If you need to add a new piece of information to the bot's memory (e.g., tracking a new user metric), add the property to the `ChannelState` or `UserState` interface definitions in `contextManager.js` and initialize it in the `_getOrCreateChannelState` or `_getOrCreateUserState` functions.
-   Changes to how chat history is pruned or when summaries are triggered should be made in `contextManager.js` and `summarizer.js`.

### Interacting with Context:

-   From any other part of the application (like a command handler), **always** use `getContextManager()` to access state. Do not attempt to manage state locally.
-   When providing context to the LLM, use the `getContextForLLM` helper function to ensure a consistent format.

### Storage and Persistence:

-   Any new channel-specific setting that needs to persist between bot restarts should have its own storage module (like `languageStorage.js`) that reads from and writes to Firestore.
-   Ensure any new storage module is initialized in `bot.js` at startup.

---