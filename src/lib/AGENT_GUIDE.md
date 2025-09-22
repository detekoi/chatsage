# AI Agent Guide: `/src/lib` Directory

## 1. Overview

This directory contains shared, low-level libraries and utilities that support the entire application. These modules are generally not specific to any single feature but are used by many components.

- **`logger.js`**: The centralized Pino logger. All application logging should be done through this module.
- **`ircSender.js`**: A rate-limited message queue for sending messages to Twitch IRC. **All bot messages must be sent via this module's `enqueueMessage` function.**
- **`secretManager.js`**: A client for securely accessing secrets from Google Secret Manager.
- **`timeUtils.js`**: Utility functions for handling time and timezones.
- **`translationUtils.js`**: A utility for translating text using the Gemini API.

---

## 2. Making Code Changes

### Modifying a Library:

-   Changes made here can have wide-ranging effects. Be sure to understand which components use a library before modifying it.
-   For example, changing the `IRC_SEND_INTERVAL_MS` in `ircSender.js` will affect the rate at which all bot messages are sent.

### Adding a New Library:

-   If you have a piece of logic that will be reused in multiple, unrelated parts of the application, it's a good candidate for a new file in `src/lib/`.
-   Ensure the new library is self-contained and does not have circular dependencies on higher-level components.

### Best Practices:

-   **Do not** place feature-specific logic here. Feature logic belongs in `src/components/`.
-   These modules should be highly reliable and well-tested.
-   If a library needs to be initialized (like `secretManager.js`), ensure it is called early in the application's startup sequence in `src/bot.js`.

---