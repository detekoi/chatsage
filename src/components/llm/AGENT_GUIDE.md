# AI Agent Guide: `/src/components/llm` Directory

## 1. Overview

This directory contains all modules related to interacting with the Google Gemini Large Language Model (LLM).

- **`geminiClient.js`**: The primary client for interacting with the Gemini API. It initializes the SDK, defines the core system prompt (the bot's persona), and exports functions for generating text (`generateStandardResponse`, `generateSearchResponse`).
- **`geminiImageClient.js`**: A specialized client for handling image-based analysis using Gemini's multimodal capabilities.
- **`botResponseHandler.js`**: A wrapper for sending messages that handles automatic translation based on channel settings. All bot-generated messages should pass through this handler.
- **`llmUtils.js`**: Utility functions related to the LLM, such as stripping markdown or handling standard queries.

---

## 2. Making Code Changes

### Modifying the Bot's Persona:

-   Changes to the bot's core personality, tone, or behavioral rules should be made to the `CHAT_SAGE_SYSTEM_INSTRUCTION` constant in `geminiClient.js`.

### Adding New LLM Functionality:

1.  Add a new function to `geminiClient.js` that encapsulates the specific type of LLM call you need (e.g., a new function for a different type of content generation).
2.  If the new function requires a tool (like search or function calling), define the tool within `geminiClient.js`.
3.  Call your new function from the relevant command handler or manager.

### Handling LLM Responses:

-   Always use the `sendBotResponse` function from `botResponseHandler.js` when sending an LLM-generated message to a channel. This ensures that the bot respects any language settings for that channel.
-   Use `llmUtils.js` to strip unwanted artifacts (like markdown) from the LLM's response before sending it.

---