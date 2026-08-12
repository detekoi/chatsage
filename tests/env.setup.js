// tests/env.setup.js
//
// Registered as `setupFiles` (NOT `setupFilesAfterEach`/`setupFilesAfterEnv`) so it runs
// before the test framework is installed, and therefore before any top-level import in a
// test file evaluates src/config/loader.js.
//
// src/config/loader.js validates required env vars at module scope and throws. Nearly every
// module reaches it transitively (logger -> config, helixClient -> config, ircSender ->
// chatClient -> config), so without these placeholders any test that imports application
// code dies with "Test suite failed to run: Missing required environment variables".
// Locally the repo's .env masked this; a clean checkout on CI has no .env.
//
// Every value is a placeholder. Anything that would make a real network call is mocked in
// the individual suites, so these only need to be present and non-empty.

const placeholders = {
    // Required by loadConfig() — absence of any of these throws at import time.
    TWITCH_BOT_USERNAME: 'test-bot',
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'test-client-secret',
    GEMINI_API_KEY: 'test-gemini-key',
    OPENAI_API_KEY: 'test-openai-key',

    // Not required by loadConfig(), but read into `config.webui` at import time.
    // config.webui.internalToken has no default (falls back to null), and
    // adSchedulePoller bails out early when it is missing, so the ad suites need it.
    WEBUI_BASE_URL: 'https://webui.test.invalid',
    WEBUI_INTERNAL_TOKEN: 'test-internal-token',
};

// Only fill gaps: a real value supplied by the shell, .env, or CI always wins.
// loadConfig() treats an empty string as missing too, so test the value rather than
// just key presence.
for (const [key, value] of Object.entries(placeholders)) {
    if (!process.env[key]) {
        process.env[key] = value;
    }
}
