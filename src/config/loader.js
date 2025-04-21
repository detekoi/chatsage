import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env file if it exists in the project root
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Go up two levels from src/config to the project root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * Loads, validates, and exports application configuration.
 */
function loadConfig() {
    const requiredEnvVars = [
        'TWITCH_BOT_USERNAME',
        'TWITCH_BOT_OAUTH_TOKEN',
        'TWITCH_CHANNELS',
        'GEMINI_API_KEY',
        'TWITCH_CLIENT_ID',
        'TWITCH_CLIENT_SECRET',
        // GEMINI_MODEL_ID has a default, so not strictly required here
    ];

    const missingEnvVars = requiredEnvVars.filter(key => !(key in process.env));

    if (missingEnvVars.length > 0) {
        throw new Error(
            `Missing required environment variables: ${missingEnvVars.join(', ')}`
        );
    }

    // Validate OAuth token format
    if (!process.env.TWITCH_BOT_OAUTH_TOKEN?.startsWith('oauth:')) {
        console.warn(
            'TWITCH_BOT_OAUTH_TOKEN does not seem to start with "oauth:", ensure it is formatted correctly.'
        );
        // Note: We allow proceeding but warn, as twitchtokengenerator sometimes omits it initially.
        // The `tmi.js` library might handle it, but correct format is preferred.
    }


    const config = {
        // Twitch Bot Account
        twitch: {
            username: process.env.TWITCH_BOT_USERNAME,
            oauthToken: process.env.TWITCH_BOT_OAUTH_TOKEN,
            // Split channels string into an array, trim whitespace, and filter empty strings
            channels: process.env.TWITCH_CHANNELS
                .split(',')
                .map(ch => ch.trim())
                .filter(ch => ch.length > 0),
            clientId: process.env.TWITCH_CLIENT_ID,
            clientSecret: process.env.TWITCH_CLIENT_SECRET,
        },

        // Google Gemini API
        gemini: {
            apiKey: process.env.GEMINI_API_KEY,
            modelId: process.env.GEMINI_MODEL_ID || 'gemini-2.0-flash-001',
        },

        // Application Behavior
        app: {
            streamInfoFetchIntervalMs: (parseInt(process.env.STREAM_INFO_FETCH_INTERVAL_SECONDS, 10) || 120) * 1000,
            logLevel: process.env.LOG_LEVEL || 'info',
            prettyLog: process.env.PINO_PRETTY_LOGGING === 'true',
            nodeEnv: process.env.NODE_ENV || 'development',
        },
    };

    // Validate interval is a positive number
    if (isNaN(config.app.streamInfoFetchIntervalMs) || config.app.streamInfoFetchIntervalMs <= 0) {
         console.warn(`Invalid STREAM_INFO_FETCH_INTERVAL_SECONDS. Using default 120 seconds.`);
         config.app.streamInfoFetchIntervalMs = 120 * 1000;
    }

    // Basic check for channel list
    if (config.twitch.channels.length === 0) {
         throw new Error('TWITCH_CHANNELS environment variable is empty or invalid.');
    }


    return config;
}

// Export the result of the function, not the function itself
export default loadConfig();