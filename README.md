# StreamSage

StreamSage is an AI-powered chatbot designed for Twitch chat environments. It provides contextually relevant responses based on chat history, user queries, and real-time stream information (current game, title, tags).

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
    git clone https://github.com/your-username/streamsage.git
    cd streamsage
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

StreamSage is configured primarily through environment variables. The required and optional variables are documented in the `.env.example` file. Key variables include:

*   `TWITCH_BOT_USERNAME`, `TWITCH_BOT_OAUTH_TOKEN`: Credentials for the bot's Twitch account.
*   `TWITCH_CHANNELS`: Comma-separated list of channels to join.
*   `GEMINI_API_KEY`: Your API key for the Google Gemini service.
*   `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`: Credentials for your registered Twitch application (used for Helix API calls).
*   `STREAM_INFO_FETCH_INTERVAL_SECONDS`: How often to refresh stream context data.
*   `LOG_LEVEL`: Controls the verbosity of logs.

Ensure all required variables are set in your environment or `.env` file before running the bot.

## Docker

A `Dockerfile` is provided for building a container image of the application.

1.  **Build the image:**
    ```bash
    docker build -t streamsage:latest .
    ```

2.  **Run the container:**
    You need to pass the environment variables to the container. One way is using an environment file:
    ```bash
    docker run --rm --env-file ./.env -it streamsage:latest
    ```
    *(Ensure your `.env` file is populated correctly)*

## Contributing

Contributions are welcome. Please open an issue or submit a pull request. (Further contribution guidelines can be added here).

## License

This project is licensed under the BSD 2-Clause License. See the [LICENSE.md](LICENSE.md) file for details.