// src/lib/secretManager.js
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import logger from './logger.js';

let client = null;

/**
 * Initializes the Secret Manager client.
 */
function initializeSecretManager() {
    if (client) {
        logger.warn('Secret Manager client already initialized.');
        return;
    }
    try {
        logger.info('Initializing Google Cloud Secret Manager client...');
        client = new SecretManagerServiceClient();
        logger.info('Secret Manager client initialized successfully.');
    } catch (error) {
        // In local development, allow running without Secret Manager
        const isDev = (process.env.NODE_ENV || 'development') === 'development';
        const hasLocalRefreshToken = !!process.env.TWITCH_BOT_REFRESH_TOKEN;
        if (isDev || hasLocalRefreshToken || process.env.ALLOW_SECRET_MANAGER_MISSING === 'true') {
            logger.warn({ err: { message: error.message } }, 'Secret Manager client init failed. Continuing without Secret Manager (dev/local token mode).');
            client = null; // Explicitly keep null; callers should handle fallback
            return;
        }
        logger.fatal({ err: error }, 'Failed to initialize Secret Manager client. Ensure ADC or credentials are configured.');
        throw error; // In production, prevent startup if secret manager cannot be initialized
    }
}

/**
 * Gets the initialized Secret Manager client.
 * @returns {SecretManagerServiceClient}
 */
function getSecretManagerClient() {
    if (!client) {
        // Attempt lazy initialization if not done explicitly
        logger.warn('Secret Manager client accessed before explicit initialization. Attempting lazy init.');
        initializeSecretManager();
        if (!client) {
             throw new Error('Secret Manager client could not be initialized.');
        }
    }
    return client;
}

/**
 * Retrieves the value of a secret from Google Secret Manager.
 * @param {string} secretResourceName - The full resource name of the secret version
 * (e.g., projects/PROJECT_ID/secrets/SECRET_NAME/versions/latest).
 * @returns {Promise<string|null>} The secret value as a string, or null if not found or on error.
 */
async function getSecretValue(secretResourceName) {
    if (!secretResourceName) {
        logger.error('getSecretValue called with empty secretResourceName.');
        return null;
    }
    const smClient = getSecretManagerClient();
    try {
        logger.debug(`Accessing secret: ${secretResourceName}`);
        const [version] = await smClient.accessSecretVersion({
            name: secretResourceName,
        });

        if (!version.payload?.data) {
            logger.warn(`Secret payload data is missing for ${secretResourceName}.`);
            return null;
        }

        // Decode the secret value (it's base64 encoded by default)
        const secretValue = version.payload.data.toString('utf8');
        logger.info(`Successfully retrieved secret: ${secretResourceName.split('/secrets/')[1].split('/')[0]} (version: ${secretResourceName.split('/').pop()})`);
        return secretValue;
    } catch (error) {
        // Log specific GCP error codes if available
        logger.error(
            { err: { message: error.message, code: error.code }, secretName: secretResourceName },
            `Failed to access secret version ${secretResourceName}. Check permissions and secret existence.`
        );
        // Handle common errors specifically if needed
        if (error.code === 5) { // 5 = NOT_FOUND
             logger.error(`Secret or version not found: ${secretResourceName}`);
        } else if (error.code === 7) { // 7 = PERMISSION_DENIED
             logger.error(`Permission denied accessing secret: ${secretResourceName}. Check IAM roles.`);
        }
        return null; // Return null on error
    }
}

/**
 * Adds a new version to an existing secret in Google Secret Manager.
 * @param {string} secretResourceName - The full resource name of the secret
 * (e.g., projects/PROJECT_ID/secrets/SECRET_NAME).
 * @param {string} secretValue - The value to store in the secret.
 * @returns {Promise<boolean>} True if successful, false otherwise.
 */
async function setSecretValue(secretResourceName, secretValue) {
    if (!secretResourceName || !secretValue) {
        logger.error('setSecretValue called with empty secretResourceName or secretValue.');
        return false;
    }
    const smClient = getSecretManagerClient();
    try {
        logger.debug(`Adding new version to secret: ${secretResourceName}`);
        
        // Add a new version to the existing secret
        const [version] = await smClient.addSecretVersion({
            parent: secretResourceName,
            payload: {
                data: Buffer.from(secretValue, 'utf8'),
            },
        });

        logger.info(`Successfully added new version to secret: ${secretResourceName.split('/secrets/')[1]} (version: ${version.name.split('/').pop()})`);
        return true;
    } catch (error) {
        logger.error(
            { err: { message: error.message, code: error.code }, secretName: secretResourceName },
            `Failed to add version to secret ${secretResourceName}. Check permissions and secret existence.`
        );
        // Handle common errors specifically
        if (error.code === 5) { // 5 = NOT_FOUND
            logger.error(`Secret not found: ${secretResourceName}`);
        } else if (error.code === 7) { // 7 = PERMISSION_DENIED
            logger.error(`Permission denied adding version to secret: ${secretResourceName}. Check IAM roles.`);
        }
        return false;
    }
}

export { initializeSecretManager, getSecretValue, setSecretValue };