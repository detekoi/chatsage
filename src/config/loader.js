import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs'; // Import fs to check if file exists

// Assume the process runs from the project root (where package.json is)
const projectRoot = process.cwd();
const envPath = path.resolve(projectRoot, '.env');

// Check if the .env file actually exists at that path before trying to load it
if (fs.existsSync(envPath)) {
  console.log(`[ConfigLoader] Loading .env file from: ${envPath}`); // Optional: for debugging
  dotenv.config({ path: envPath });
} else {
  // Optional: Log if not found, relying on environment variables instead
  // console.warn(`[ConfigLoader] .env file not found at ${envPath}. Relying on system environment variables.`);
}

/**
 * Loads, validates, and exports application configuration.
 */
function loadConfig() {
    const requiredEnvVars = [
        'TWITCH_BOT_USERNAME',
        'GEMINI_API_KEY',
        'TWITCH_CLIENT_ID',
        'TWITCH_CLIENT_SECRET',
        // GEMINI_MODEL_ID has a default, so not strictly required here
    ];

    // Secret requirement logic:
    // If TWITCH_BOT_REFRESH_TOKEN is NOT provided directly (e.g., local dev),
    // then require TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME for Secret Manager.
    if (!process.env.TWITCH_BOT_REFRESH_TOKEN) {
        requiredEnvVars.push('TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME');
    }

    const missingEnvVars = requiredEnvVars.filter(key => !(key in process.env) || process.env[key] === '');

    if (missingEnvVars.length > 0) {
        throw new Error(
            `Missing required environment variables: ${missingEnvVars.join(', ')}`
        );
    }
    // Channel list is now loaded from Firestore in src/bot.js. Env-based channel
    // configuration is optional and no longer enforced here.

    // REMOVED OAuth token validation - No longer loaded directly


    const config = {
        // Twitch Bot Account
        twitch: {
            username: process.env.TWITCH_BOT_USERNAME,
            // Channels list: can be provided via TWITCH_CHANNELS env for local dev
            channels: process.env.TWITCH_CHANNELS
                ? process.env.TWITCH_CHANNELS.split(',').map(ch => ch.trim()).filter(ch => ch)
                : [],
            clientId: process.env.TWITCH_CLIENT_ID,
            clientSecret: process.env.TWITCH_CLIENT_SECRET,
            publicUrl: process.env.PUBLIC_URL,
        },

        // Google Gemini API
        gemini: {
            apiKey: process.env.GEMINI_API_KEY,
            modelId: process.env.GEMINI_MODEL_ID || 'gemini-2.5-flash-preview-05-20',
        },

        // Application Behavior
        app: {
            streamInfoFetchIntervalMs: (parseInt(process.env.STREAM_INFO_FETCH_INTERVAL_SECONDS, 10) || 120) * 1000,
            logLevel: process.env.LOG_LEVEL || 'info',
            prettyLog: process.env.PINO_PRETTY_LOGGING === 'true',
            nodeEnv: process.env.NODE_ENV || 'development',
            // Optional allow-list: if present and non-empty, only these channels are allowed
            allowedChannels: process.env.ALLOWED_CHANNELS
                ? process.env.ALLOWED_CHANNELS.split(',').map(ch => ch.trim().toLowerCase()).filter(Boolean)
                : [],
        },

        // Secret Manager Configuration
        secrets: {
            twitchBotRefreshTokenName: process.env.TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME,
            // Optional: resource name for channels list in Secret Manager
            twitchChannelsSecretName: process.env.TWITCH_CHANNELS_SECRET_NAME || null,
            // Optional: resource name for allowed channels list in Secret Manager
            allowedChannelsSecretName: process.env.ALLOWED_CHANNELS_SECRET_NAME || null,
        }
    };

    // Validate interval is a positive number
    if (isNaN(config.app.streamInfoFetchIntervalMs) || config.app.streamInfoFetchIntervalMs <= 0) {
         console.warn(`Invalid STREAM_INFO_FETCH_INTERVAL_SECONDS. Using default 120 seconds.`);
         config.app.streamInfoFetchIntervalMs = 120 * 1000;
    }

    const eventSubSecretSource = process.env.TWITCH_EVENTSUB_SECRET;
    if (eventSubSecretSource && fs.existsSync(eventSubSecretSource)) {
        // In Cloud Run, the env var is a path to a file. Read it.
        config.twitch.eventSubSecret = fs.readFileSync(eventSubSecretSource, 'utf8').trim();
    } else {
        // For local dev, the env var holds the secret value directly.
        config.twitch.eventSubSecret = eventSubSecretSource;
    }


    return config;
}

// Export the result of the function, not the function itself
export default loadConfig();