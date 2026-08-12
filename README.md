[![English](https://img.shields.io/badge/lang-English-blue?style=flat)](README.md)
[![Español (MX)](https://img.shields.io/badge/lang-Español%20(MX)-red?style=flat)](docs/README-es-mx.md)
[![Português (BR)](https://img.shields.io/badge/lang-Português%20(BR)-green?style=flat)](docs/README-pt-br.md)
[![Deutsch](https://img.shields.io/badge/lang-Deutsch-yellow?style=flat)](docs/README-de.md)
[![Français](https://img.shields.io/badge/lang-Français-lightgrey?style=flat)](docs/README-fr.md)
[![Italiano](https://img.shields.io/badge/lang-Italiano-orange?style=flat)](docs/README-it.md)
[![日本語](https://img.shields.io/badge/lang-日本語-violet?style=flat)](docs/README-ja.md)
[![Русский](https://img.shields.io/badge/lang-Русский-lightcoral?style=flat)](docs/README-ru.md)

# WildcatSage

WildcatSage is an AI-powered chatbot for Twitch chat. WildcatSage generates contextually relevant responses from chat history, user queries, and real-time stream metadata (current game, title, and tags).

[![License](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE.md)

> **IMPORTANT:** Access to the cloud version of WildcatSage is invite-only. Unapproved channels cannot access the management interface. If you want to try the bot, use [this contact form](https://parfaitfair.com/#contact).

## Table of Contents

- [Features](#features)
- [Adding WildcatSage to Your Channel](#adding-wildcatsage-to-your-channel)
- [Usage Examples](#usage-examples)
- [Development Prerequisites](#development-prerequisites)
- [Getting Started](#getting-started)
- [Running the Bot](#running-the-bot)
- [Configuration](#configuration)
- [Twitch Token Management](#twitch-token-management)
- [Docker](#docker)
- [Deploying to Cloud Run](#deploying-to-cloud-run)

## Features

- Receive chat messages through Twitch EventSub webhooks.
- Send chat replies through the Twitch Helix API.
- Fetch real-time stream metadata (game, title, tags, thumbnail images) through the Twitch Helix API.
- Generate main responses with OpenAI GPT 5.6 Luna for reasoning, queries, games, check-ins, and commands.
- Process speed-critical tasks (`!lurk`, `!translate`, summarization, emote descriptions) with Google Gemini 3.5 Flash Lite.
- Maintain conversation history and summaries for each channel.
- Execute custom chat commands with permission checks.
- Support multilingual channels through configuration settings.
- Read settings from environment variables.
- Write structured JSON logs for production monitoring.
- Provide a web interface for streamers to manage bot access.

## Adding WildcatSage to Your Channel

> **NOTE:** Only approved channels on the allow-list can enable WildcatSage. If your channel is not approved, use [this contact form](https://parfaitfair.com/#contact) to request access.

If your channel is approved, follow these steps to add or remove WildcatSage:

1. **Open the WildcatSage Management Portal:**
   - Go to [bot.wildcat.chat](https://bot.wildcat.chat).
   - Select **Login with Twitch**.

2. **Authorize the Application:**
   - Twitch prompts you to authorize WildcatSage.
   - Grant the required permissions. The process uses standard Twitch OAuth 2.0.

3. **Manage the Bot:**
   - View your channel dashboard.
   - Select **Add Bot to My Channel** to add WildcatSage to your channel.
   - Select **Remove Bot from My Channel** to remove WildcatSage from your channel.

4. **Bot Joining Time:**
   - After you add the bot, WildcatSage joins your channel within a few minutes.
   - If the bot does not join after 10 minutes, remove the bot and add it again.
   - If the bot does not reply to chat, grant moderator status with the `/mod WildcatSageBot` command.

5. **User Interaction:**
   - Viewers can talk to WildcatSage by mentioning the bot name: `@WildcatSageBot hello`.
   - Viewers can use [bot commands](https://docs.wildcat.chat/botcommands.html) such as `!ask` and `!translate`.

## Usage Examples

### Chat Commands

For a full list of commands, read the [Bot Commands Documentation](https://docs.wildcat.chat/botcommands.html).

### Context-Aware Responses

WildcatSage reads the conversation context before it replies. For example, the `!lurk` command creates a personal send-off.

**Scenario:** The chat discusses making dinner.

> **User:** `!lurk going to make some pasta`
>
> **WildcatSageBot:** `@user, enjoy making the pasta! Hope it turns out delicious. We'll be here when you get back!`

## Development Prerequisites

Make sure that you install these tools on your computer:

- Node.js (version 22.0.0 or later)
- npm (or yarn)

## Getting Started

1. **Clone the repository:**

   ```bash
   git clone https://github.com/detekoi/chatsage.git
   cd chatsage
   ```

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Configure environment variables:**
   - Copy the example environment file:

     ```bash
     cp .env.example .env
     ```

   - Edit the `.env` file to add your API keys and credentials. Read the comments in `.env.example` for details on each variable. Do not commit your `.env` file to source control.

## Running the Bot

- **Development:**
  Node watches files and restarts the bot automatically when code changes. If `PINO_PRETTY_LOGGING=true` in `.env`, the bot prints human-readable logs.

  ```bash
  npm run dev
  ```

- **Production:**
  Run the bot with standard Node.js. The bot outputs structured JSON logs.

  ```bash
  npm start
  ```

## Configuration

Configure WildcatSage through environment variables. The `.env.example` file lists all required and optional variables:

- `TWITCH_BOT_USERNAME`: Username for the Twitch bot account.
- `TWITCH_CHANNELS`: Comma-separated list of channels to join in local development. In production the bot loads its channel list from Firestore.
- `TWITCH_CHANNELS_SECRET_NAME`: Resource name for the channel list in Google Secret Manager. Read by `scripts/migrate-channels-to-firestore.js`; the running bot does not read it.
- `OPENAI_API_KEY`: API key for OpenAI services (GPT 5.6 Luna model).
- `GEMINI_API_KEY`: API key for Google Gemini services (Gemini 3.5 Flash Lite model).
- `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`: Credentials for your registered Twitch application.
- `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME`: Resource name for the refresh token in Google Secret Manager.
- `STREAM_INFO_FETCH_INTERVAL_SECONDS`: Interval in seconds between stream metadata updates.
- `LOG_LEVEL`: Log verbosity level.

Make sure that you set all required variables in your environment or `.env` file before you start the bot.

## Twitch Token Management

### Bot Authentication Setup

1. **Prerequisites for Token Generation:**
   - Register an application in the [Twitch Developer Console](https://dev.twitch.tv/console/). Note your **Client ID** and **Client Secret**.
   - In your Twitch Application settings, add `http://localhost:3000` as an OAuth Redirect URL.
   - Install the [Twitch CLI](https://dev.twitch.tv/docs/cli/install).

2. **Configure Twitch CLI:**
   - Open a terminal.
   - Run `twitch configure`.
   - Enter your **Client ID** and **Client Secret** when prompted.

3. **Generate User Access Token and Refresh Token:**
   - Run this command in your terminal:

     ```bash
     twitch token -u -s 'user:read:chat user:write:chat'
     ```

   - Copy the generated URL from the terminal output and paste it into your browser.
   - Log in to Twitch with the account that the bot uses.
   - Authorize the application for the requested scopes.
   - Twitch redirects your browser to `http://localhost:3000`. The Twitch CLI captures the authorization code and exchanges it for tokens.
   - The CLI prints the access token and refresh token in your terminal.

4. **Store the Refresh Token in Secret Manager:**
   - Copy the refresh token from the Twitch CLI output.
   - Create a secret in Google Secret Manager and paste the refresh token.
   - Copy the resource name of the secret (for example, `projects/YOUR_PROJECT_ID/secrets/YOUR_SECRET_NAME/versions/latest`).
   - Set the resource name as the value for `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME` in your `.env` file or Cloud Run settings.
   - Grant the `Secret Manager Secret Accessor` IAM role to the service account that runs WildcatSage.

5. **Authentication Flow in WildcatSage:**
   - When WildcatSage starts, `auth.js` reads the refresh token from Google Secret Manager.
   - WildcatSage uses the refresh token, `TWITCH_CLIENT_ID`, and `TWITCH_CLIENT_SECRET` to request an access token from Twitch.
   - WildcatSage uses the access token to authenticate API calls and EventSub webhooks.
   - When the access token expires, WildcatSage automatically requests a new access token with the refresh token.
   - If the refresh token becomes invalid, generate a new refresh token with the Twitch CLI and update Secret Manager.

### Channel Management Web Interface

The web interface uses a separate OAuth flow to manage channels:

1. **Firebase Setup:**
   - Firebase Functions and Hosting run the web interface.
   - Streamers authenticate through Twitch OAuth 2.0.
   - Adding or removing the bot updates a Firestore collection.
   - WildcatSage checks Firestore periodically to update the list of active channels.

2. **Environment Variables for Web Interface:**
   - `TWITCH_CLIENT_ID`: Twitch application client ID.
   - `TWITCH_CLIENT_SECRET`: Twitch application client secret.
   - `CALLBACK_URL`: Deployed function URL for OAuth callbacks.
   - `FRONTEND_URL`: URL of the web interface.
   - `JWT_SECRET_KEY`: Secret key for JWT signatures.
   - `SESSION_COOKIE_SECRET`: Secret key for session cookies.

<details>
<summary><strong>EventSub for Serverless Deployment (Optional)</strong></summary>

WildcatSage supports Twitch EventSub for scale-to-zero serverless deployments on Google Cloud Run. Scale-to-zero reduces hosting costs because instances run only when a channel is live.

### Overview

- **How it works:** WildcatSage subscribes to `stream.online` events. When a streamer goes live, Twitch sends a webhook event to start a service instance. The instance runs while streams are live, and scales to zero instances when all channels are offline.
- **Cost reduction:** You pay only for compute time used during active streams.

### Required Environment Variables

Set these environment variables in your deployment environment (for example, Cloud Run):

- `TWITCH_EVENTSUB_SECRET`: Secret string to authenticate incoming webhooks.
- `PUBLIC_URL`: Public HTTPS URL of your deployed service.

### Setup Process

1. **Deploy with EventSub Variables:**
   Deploy your service with the environment variables listed above.

2. **Subscribe to Events:**
   Run the management script to subscribe all channels to `stream.online` events:

   ```bash
   node scripts/manage-eventsub.js subscribe-all
   ```

3. **Verify Subscriptions:**
   List active subscriptions to confirm setup:

   ```bash
   node scripts/manage-eventsub.js list
   ```

</details>

## Docker

Build and run WildcatSage inside a Docker container:

1. **Build the image:**

   ```bash
   docker build -t wildcatsage:latest .
   ```

2. **Run the container:**
   Pass your environment variables file to the container:

   ```bash
   docker run --rm --env-file ./.env -it wildcatsage:latest
   ```

## Deploying to Cloud Run

Deployment is automated through `.github/workflows/deploy-cloud-run.yml`. Pushing to `main` runs
the unit tests and then deploys to Cloud Run, authenticating with Workload Identity Federation and
mapping secrets from Google Secret Manager. Pushes to other branches run the tests only.

**Notes:**

- Environment values and secret mappings live in the workflow, which is the single source of truth
  for what the deployed service receives.
- On a first deployment into a new project, deploy once, copy the service URL that Cloud Run prints,
  then set `PUBLIC_URL` in the workflow to that value and deploy again.
