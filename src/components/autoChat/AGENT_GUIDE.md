# AI Agent Guide: `/src/components/autoChat` Directory

## 1. Overview

This directory contains the logic for the "Auto-Chat" feature, which allows the bot to proactively send messages in chat to keep the conversation engaging.

- **`autoChatManager.js`**: The core of the feature. It runs on a timer and decides if and what kind of message to send based on the current context (e.g., a lull in conversation, a change in game). It also handles one-off notifications for events like follows, subs, and raids.
- **`autoChatStorage.js`**: Manages the persistent configuration for auto-chat (e.g., mode, enabled categories) in Firestore. This is controlled by the `!auto` command.

---

## 2. Making Code Changes

### Modifying Auto-Chat Behavior:

-   To change how often the auto-chat manager runs, modify the `TICK_MS` constant in `autoChatManager.js`.
-   To change the conditions under which the bot speaks (e.g., the definition of a "lull"), modify the logic within the main interval loop in `startAutoChatManager`.
-   The prompts used for generating auto-chat messages (greetings, game change comments, etc.) are all located within `autoChatManager.js`. Modifying these prompts will change the content and tone of the bot's proactive messages.

### Adding a New Auto-Chat Trigger:

1.  Create a new function in `autoChatManager.js` that contains the logic for the new trigger (e.g., `maybeSendWeatherUpdate`).
2.  This function should check the channel's auto-chat config from `autoChatStorage.js` to see if the category is enabled.
3.  Call this new function from the main interval loop or from an external event trigger (like in `bot.js`).

---