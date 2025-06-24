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
        'TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME',
        // GEMINI_MODEL_ID has a default, so not strictly required here
    ];

    const missingEnvVars = requiredEnvVars.filter(key => !(key in process.env));

    if (missingEnvVars.length > 0) {
        throw new Error(
            `Missing required environment variables: ${missingEnvVars.join(', ')}`
        );
    }
    // Ensure at least one channel source is provided (unless using lazy connect with Firestore)
    const isLazyConnect = process.env.LAZY_CONNECT === '1' || process.env.LAZY_CONNECT === 'true';
    if (!isLazyConnect && !('TWITCH_CHANNELS' in process.env) && !('TWITCH_CHANNELS_SECRET_NAME' in process.env)) {
        throw new Error('Missing channel configuration: set TWITCH_CHANNELS or TWITCH_CHANNELS_SECRET_NAME');
    }

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
        },

        // Secret Manager Configuration
        secrets: {
            twitchBotRefreshTokenName: process.env.TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME,
            // Optional: resource name for channels list in Secret Manager
            twitchChannelsSecretName: process.env.TWITCH_CHANNELS_SECRET_NAME || null,
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