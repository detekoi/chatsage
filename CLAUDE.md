# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands
- Run: `npm start` or `npm run dev` (watch mode)
- Lint: `npm run lint`
- Test: `node tests/unit/components/twitch/helixClient.test.js`

## Code Style
- **Language**: ES Modules with explicit `.js` extensions in imports
- **Naming**: camelCase for variables/functions, descriptive names
- **Format**: Indent with 4 spaces
- **Promises**: Prefer async/await over Promise chains
- **Logging**: Use logger.{level} with object context where appropriate

## Architecture Guidelines
- Command pattern for Twitch chat commands
- Component-based architecture with clean separation of concerns
- Use context manager for stream information
- Explicit error handling for external API calls

## Development Rules
- All Twitch API calls must use `helixClient.js` (never direct axios)
- All bot messages must use `enqueueMessage()` from `ircSender.js`
- All logging must use centralized `logger` from `src/lib/logger.js`
- Access configuration only via `src/config/index.js` (never `process.env`)
- Use `getContextManager()` for all state access
- LLM responses must go through `sendBotResponse()` from `botResponseHandler.js`