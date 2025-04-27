# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands
- Run: `npm start` or `npm run dev` (watch mode)
- Lint: `npm run lint`
- Test: Tests are configured but not fully implemented yet
- For single test: Run `node tests/unit/components/twitch/helixClient.test.js`

## Code Style
- **Language**: ES Modules with explicit `.js` extensions in imports
- **Naming**: camelCase for variables/functions, descriptive names
- **Imports**: Group imports by category (core libs, components, utils)
- **Error Handling**: Use try/catch with specific error logging via Pino
- **Format**: Indent with 4 spaces
- **Promises**: Prefer async/await over Promise chains
- **Logging**: Use logger.{level} with object context where appropriate

## Architecture Guidelines
- Command pattern for Twitch chat commands
- Component-based architecture with clean separation of concerns
- Use context manager for stream information
- Explicit error handling for external API calls