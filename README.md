[![English](https://img.shields.io/badge/lang-English-blue?style=flat)](README.md)
[![Español (MX)](https://img.shields.io/badge/lang-Español%20(MX)-red?style=flat)](docs/README-es-mx.md)
[![Português (BR)](https://img.shields.io/badge/lang-Português%20(BR)-green?style=flat)](docs/README-pt-br.md)
[![Deutsch](https://img.shields.io/badge/lang-Deutsch-yellow?style=flat)](docs/README-de.md)
[![Français](https://img.shields.io/badge/lang-Français-lightgrey?style=flat)](docs/README-fr.md)
[![Italiano](https://img.shields.io/badge/lang-Italiano-orange?style=flat)](docs/README-it.md)
[![日本語](https://img.shields.io/badge/lang-日本語-violet?style=flat)](docs/README-ja.md)
[![Русский](https://img.shields.io/badge/lang-Русский-lightcoral?style=flat)](docs/README-ru.md)


# ChatSage

ChatSage is an AI-powered chatbot designed for Twitch chat environments in any language. It provides contextually relevant responses based on chat history, user queries, and real-time stream information (current game, title, tags).

**[Add ChatSage to your Twitch channel →](https://streamsage-bot.web.app)**

[![License](https://img.shields.io/badge/License-BSD%202--Clause-blue.svg)](LICENSE.md) 

## Table of Contents

- [Features (Core Capabilities)](#features-core-capabilities)
- [Adding ChatSage to Your Channel](#adding-chatsage-to-your-channel)
- [Usage Examples](#usage-examples)
- [Development Prerequisites](#development-prerequisites)
- [Getting Started](#getting-started)
- [Running the Bot](#running-the-bot)
- [Configuration](#configuration)
- [Twitch Token Management](#twitch-token-management)
- [Docker](#docker)

## Features (Core Capabilities)

*   Connects to specified Twitch channels via IRC.
*   Fetches real-time stream context (game, title, tags, thumbnail images) using the Twitch Helix API.
*   Utilizes Google's Gemini 2.5 Flash LLM for natural language understanding and response generation.
*   Maintains conversation context (history and summaries) per channel.
*   Supports custom chat commands with permission levels.
*   Configurable bot language settings for multilingual channel support.
*   Configurable through environment variables.
*   Includes structured logging suitable for production environments.
*   Web-based channel management interface for streamers to add/remove the bot.

## Adding ChatSage to Your Channel

Streamers can now easily add or remove ChatSage from their channel using the web interface:

1. **Visit the ChatSage Management Portal**:
   - Go to [ChatSage Management Portal](https://streamsage-bot.web.app)
   - Click on "Login with Twitch"

2. **Authorize the Application**:
   - You'll be redirected to Twitch to authorize ChatSage
   - Grant the required permissions
   - This process is secure and uses Twitch's OAuth flow

3. **Manage the Bot**:
   - Once logged in, you'll see your dashboard
   - Use the "Add Bot to My Channel" button to have ChatSage join your channel
   - Use "Remove Bot from My Channel" if you want to remove it

4. **Bot Joining Time**:
   - After adding the bot, it should join your channel within a few minutes
   - If the bot doesn't join after 10 minutes, please try removing and adding again
   - Important: if the bot is not responding, grant it mod status with the command "/mod StreamSageTheBot"

5. **User Interaction**:
   - Viewers can interact with ChatSage by mentioning it: `@StreamSageTheBot hello` (the username will be updated to reflect the new name, ChatSage, when Twitch allows me)
   - Or by using various [commands](https://detekoi.github.io/botcommands.html) like `!ask`, `!translate`, etc.

## Usage Examples

### Chat Commands

For a complete list of available commands and their usage, please visit [Bot Commands Documentation](https://detekoi.github.io/botcommands.html).

## Development Prerequisites

*   Node.js (Version 22.0.0 or later recommended)
*   npm (or yarn)

## Getting Started

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/detekoi/chatsage.git
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
*   `TWITCH_CHANNELS`: Comma-separated list of channels to join. Used as fallback if Firestore channel management is unavailable.
*   `TWITCH_CHANNELS_SECRET_NAME`: Resource name for the channels list in Google Secret Manager. Used as fallback if Firestore channel management is unavailable.
*   `GEMINI_API_KEY`: Your API key for the Google Gemini service.
*   `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`: Credentials for your registered Twitch application (used for Helix API calls).
*   `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME`: Resource name for the refresh token in Google Secret Manager.
*   `STREAM_INFO_FETCH_INTERVAL_SECONDS`: How often to refresh stream context data.
*   `LOG_LEVEL`: Controls the verbosity of logs.

Ensure all required variables are set in your environment or `.env` file before running the bot.

## Twitch Token Management

ChatSage uses a secure token refresh mechanism to maintain authentication with Twitch:

### Bot IRC Authentication

1.  **Prerequisites for Token Generation**:
    * **Twitch Application**: Ensure you have registered an application on the [Twitch Developer Console](https://dev.twitch.tv/console/). Note your **Client ID** and generate a **Client Secret**.
    * **OAuth Redirect URI**: In your Twitch Application settings, add `http://localhost:3000` as an OAuth Redirect URL. The Twitch CLI specifically uses this as the first redirect URL by default.
    * **Twitch CLI**: Install the [Twitch CLI](https://dev.twitch.tv/docs/cli/install) on your local machine.

2.  **Configure Twitch CLI**:
    * Open your terminal or command prompt.
    * Run `twitch configure`.
    * When prompted, enter the **Client ID** and **Client Secret** from your Twitch Application.

3.  **Generate User Access Token and Refresh Token using Twitch CLI**:
    * Run the following command in your terminal. Replace `<your_scopes>` with a space-separated list of scopes required for your bot. For ChatSage, you need at least `chat:read` and `chat:edit`.
        ```bash
        twitch token -u -s 'chat:read chat:edit'
        ```
        *(You can add other scopes if your bot's custom commands need them, e.g., `channel:manage:polls channel:read:subscriptions`)*
    * The CLI will output a URL. Copy this URL and paste it into your web browser.
    * Log in to Twitch using the **Twitch account you want the bot to use**.
    * Authorize your application for the requested scopes.
    * After authorization, Twitch will redirect your browser to `http://localhost:3000`. The CLI, which temporarily runs a local server, will capture the authorization code and exchange it for tokens.
    * The CLI will then print the `User Access Token`, `Refresh Token`, `Expires At` (for the access token), and the `Scopes` granted.

4.  **Store the Refresh Token Securely**:
    * From the Twitch CLI output, copy the **Refresh Token**. This is the crucial token your bot needs for long-term authentication.
    * Store this Refresh Token securely in Google Secret Manager.

5.  **Google Secret Manager Setup**:
    * Create a Google Cloud Project if you don't have one.
    * Enable the Secret Manager API in your project.
    * Create a new secret in Secret Manager to store the Twitch Refresh Token you just obtained.
    * Note the **Resource Name** of this secret. It will look like `projects/YOUR_PROJECT_ID/secrets/YOUR_SECRET_NAME/versions/latest`.
    * Set this full resource name as the value for the `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME` environment variable in your bot's configuration (e.g., in your `.env` file or Cloud Run environment variables).
    * Ensure the service account running your ChatSage application (whether locally via ADC or in Cloud Run) has the "Secret Manager Secret Accessor" IAM role for this secret.

6.  **Authentication Flow in ChatSage**:
    * On startup, ChatSage (specifically `ircAuthHelper.js`) will use the `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME` to fetch the stored refresh token from Google Secret Manager.
    * It will then use this refresh token, along with your application's `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`, to obtain a fresh, short-lived OAuth Access Token from Twitch.
    * This access token is used to connect to Twitch IRC.
    * If the access token expires or becomes invalid, the bot will use the refresh token to automatically obtain a new one.
    * If the refresh token itself becomes invalid (e.g., revoked by Twitch, user password change), the application will log a critical error, and you will need to repeat the token generation process (Steps 3-4) to get a new refresh token.

### Channel Management Web UI

The [web interface](https://github.com/detekoi/chatsage-web-ui) uses a separate OAuth flow to allow streamers to manage the bot in their channel:

1.  **Firebase Functions Setup**:
    * The web UI is built with Firebase Functions and Hosting.
    * It uses Twitch OAuth to authenticate streamers.
    * When a streamer adds or removes the bot, it updates a Firestore collection.
    * The bot periodically checks this collection to determine which channels to join or leave.

2.  **Environment Variables for Web UI**:
    * `TWITCH_CLIENT_ID`: Twitch application client ID.
    * `TWITCH_CLIENT_SECRET`: Twitch application client secret.
    * `CALLBACK_URL`: The OAuth callback URL (your deployed function URL).
    * `FRONTEND_URL`: The URL of your web interface.
    * `JWT_SECRET_KEY`: Secret for signing authentication tokens.
    * `SESSION_COOKIE_SECRET`: Secret for session cookies.

This approach provides better security by using standard OAuth flows and official tools, and not storing sensitive tokens directly in configuration files where possible. It also gives streamers control over adding or removing the bot from their channel.

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
