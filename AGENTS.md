# AGENTS.md

## Project Overview
ChatSage is a Twitch chat bot with LLM integration using Google Gemini. The bot provides interactive chat commands, games (trivia, geo-guessing), and automated responses with multi-language support.

## Setup Commands
- Install dependencies: `npm install`
- Start dev server: `npm start` or `npm run dev` (watch mode)
- Run linter: `npm run lint`
- Run single test: `node tests/unit/components/twitch/helixClient.test.js`

## Code Style
- **Language**: ES Modules with explicit `.js` extensions in imports
- **Naming**: camelCase for variables/functions, descriptive names
- **Imports**: Group by category (core libs, components, utils)
- **Format**: 4-space indentation
- **Async**: Use async/await over Promise chains
- **Logging**: Use centralized Pino logger from `src/lib/logger.js`

## Architecture Patterns
- **Command Pattern**: Chat commands in `/src/components/commands/handlers/`
- **Component-Based**: Modular features in `/src/components/`
- **Centralized State**: Use `contextManager` for all state management
- **Rate Limiting**: All IRC messages via `enqueueMessage()` from `ircSender.js`

## Key Components
- **Commands**: `/src/components/commands/` - Chat command processing
- **LLM**: `/src/components/llm/` - Gemini API integration and responses
- **Twitch**: `/src/components/twitch/` - IRC, Helix API, EventSub webhooks
- **Context**: `/src/components/context/` - State management and chat history
- **Config**: `/src/config/` - Environment variables and validation
- **Lib**: `/src/lib/` - Shared utilities (logger, IRC sender, secrets)

## Development Rules
- **API Calls**: Use `helixClient.js` for all Twitch API requests (never direct axios)
- **Bot Messages**: Use `enqueueMessage()` from `ircSender.js` (never `ircClient.say()`)
- **Logging**: Use `logger` from `src/lib/logger.js` (never `console.log`)
- **Configuration**: Import from `src/config/index.js` (never `process.env`)
- **State Access**: Use `getContextManager()` (never local state management)
- **LLM Responses**: Use `sendBotResponse()` from `botResponseHandler.js`

## Testing
- Tests are configured but not fully implemented
- Run individual tests with Node.js directly
- Focus on unit testing for components and integration testing for API clients

## Security
- All secrets managed via Google Secret Manager
- OAuth tokens handled by dedicated auth modules
- No logging of sensitive data (tokens, user data)
- Rate limiting implemented for all external API calls
