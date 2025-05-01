# ChatSage

[![License](https://img.shields.io/badge/License-BSD%202--Clause-blue.svg)](LICENSE.md) 

ChatSage is an AI-powered chatbot designed for Twitch chat environments. It provides contextually relevant responses based on chat history, user queries, and real-time stream information (current game, title, tags).

## Table of Contents

- [Features (Core Capabilities)](#features-core-capabilities)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Running the Bot](#running-the-bot)
- [Configuration](#configuration)
- [Twitch Token Management](#twitch-token-management)
- [Docker](#docker)
- [Usage Examples](#usage-examples)
- [Contributing](#contributing)
- [License](#license)

## Features (Core Capabilities)

*   Connects to specified Twitch channels via IRC.
*   Fetches real-time stream context (game, title, tags) using the Twitch Helix API.
*   Utilizes Google's Gemini Large Language Model (LLM) for natural language understanding and response generation.
*   Maintains conversation context (history and summaries) per channel.
*   Supports custom chat commands with permission levels.
*   Configurable through environment variables.
*   Includes structured logging suitable for production environments.

## Prerequisites

*   Node.js (Version 18.0.0 or later recommended)
*   npm (or yarn)

## Getting Started

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/your-username/chatsage.git
    cd chatsage
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```
    *(Or `yarn install` if you prefer Yarn)*

3.  **Configure environment variables:**
    *   Copy the example environment file:
        ```bash
        cp .env.example .env
        ```
    *   Edit the `.env` file and fill in your credentials and settings. Refer to the comments within `.env.example` for details on each variable (Twitch bot username/token, Twitch application client ID/secret, Gemini API key, channels to join, etc.). **Do not commit your `.env` file.**

## Running the Bot

*   **Development:**
    Uses Node's built-in watch mode for automatic restarts on file changes. Enables human-readable ("pretty") logs by default if `PINO_PRETTY_LOGGING=true` in `.env`.
    ```bash
    npm run dev
    ```

*   **Production:**
    Runs the bot using standard `node`. Outputs structured JSON logs suitable for log aggregation systems.
    ```bash
    npm start
    ```

## Configuration

ChatSage is configured primarily through environment variables. The required and optional variables are documented in the `.env.example` file. Key variables include:

*   `TWITCH_BOT_USERNAME`: Username for the bot's Twitch account.
*   `TWITCH_CHANNELS`: Comma-separated list of channels to join. Used for local development.
*   `TWITCH_CHANNELS_SECRET_NAME`: Resource name for the channels list in Google Secret Manager (e.g., `projects/YOUR_PROJECT_ID/secrets/twitch-channels/versions/latest`). Used in production.
*   `GEMINI_API_KEY`: Your API key for the Google Gemini service.
*   `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`: Credentials for your registered Twitch application (used for Helix API calls).
*   `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME`: Resource name for the refresh token in Google Secret Manager.
*   `STREAM_INFO_FETCH_INTERVAL_SECONDS`: How often to refresh stream context data.
*   `LOG_LEVEL`: Controls the verbosity of logs.

Ensure all required variables are set in your environment or `.env` file before running the bot.

## Twitch Token Management

ChatSage uses a secure token refresh mechanism to maintain authentication with Twitch:

1. **Initial Setup**:
   - Go to [Twitch Token Generator](https://twitchtokengenerator.com)
   - Select the required scopes: `chat:read`, `chat:edit`
   - Generate the token
   - Copy the **Refresh Token** (not the Access Token)
   - Store this Refresh Token securely in Google Secret Manager

2. **Google Secret Manager Setup**:
   - Create a Google Cloud Project if you don't have one
   - Enable the Secret Manager API
   - Create a new secret to store your refresh token
   - Note the resource name: `projects/YOUR_PROJECT_ID/secrets/YOUR_SECRET_NAME/versions/latest`
   - Set this resource name as `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME` in your `.env` file
   - Ensure the service account running your application has the "Secret Manager Secret Accessor" role

3. **Authentication Flow**:
   - On startup, ChatSage will fetch the refresh token from Secret Manager
   - It will use this refresh token to obtain a fresh access token from Twitch
   - If the access token expires, it will be automatically refreshed
   - If the refresh token itself becomes invalid, the application will log an error requiring manual intervention

This approach provides better security by not storing the OAuth token directly in configuration files and ensures the bot can maintain connectivity for longer periods.

## Docker

A `Dockerfile` is provided for building a container image of the application.

1.  **Build the image:**
    ```bash
    docker build -t chatsage:latest .
    ```

2.  **Run the container:**
    You need to pass the environment variables to the container. One way is using an environment file:
    ```bash
    docker run --rm --env-file ./.env -it chatsage:latest
    ```
    *(Ensure your `.env` file is populated correctly)*

## Usage Examples

### Chat Commands

For a complete list of available commands and their usage, please visit [Bot Commands Documentation](https://detekoi.github.io/botcommands.html).

### Sample Log Output

```bash
$ npm run dev
[INFO] Pretty logging enabled for development.
[INFO] Connected to channels: #channel1, #channel2
[INFO] Chat | user123: !help
[INFO] Response | Provided commands list to user123
```
