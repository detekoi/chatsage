// src/lib/secretManager.js
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import logger from './logger.js';
import { redact } from './redact.js';

let client = null;

// Helper for async sleep
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Extracts a display-safe name from a secret resource path.
 * e.g. 'projects/123/secrets/my-secret/versions/latest' -> 'my-secret'
 * @param {string} resourceName
 * @returns {string}
 */
function sanitizeSecretName(resourceName) {
    if (!resourceName) return '[unknown]';
    const parts = resourceName.split('/secrets/');
    if (parts.length > 1) {
        return parts[1].split('/')[0];
    }
    return '[redacted]';
}

const secretCache = new Map();

/**
 * Decodes the secret payload from a Secret Manager version response.
 * Extracted to isolate secret data from log statements in the caller.
 * @param {object} version - The version object from accessSecretVersion
 * @returns {string|null} The decoded secret value, or null if payload is missing
 */
function decodeSecretPayload(version) {
    if (!version.payload?.data) {
        return null;
    }
    return version.payload.data.toString('utf8');
}

/**
 * Initializes the Secret Manager client.
 */
function initializeSecretManager() {
    if (client) {
        logger.warn('Secret Manager client already initialized.');
        return;
    }

    const isDev = (process.env.NODE_ENV || 'development') === 'development';
    const hasLocalRefreshToken = !!process.env.TWITCH_BOT_REFRESH_TOKEN;
    const allowMissing = process.env.ALLOW_SECRET_MANAGER_MISSING === 'true';

    logger.info('Initializing Google Cloud Secret Manager client...', {
        isDev,
        hasLocalRefreshToken,
        allowMissing,
        nodeEnv: process.env.NODE_ENV
    });

    try {
        client = new SecretManagerServiceClient();
        logger.info('✅ Secret Manager client initialized successfully.', {
            isDev,
            hasLocalRefreshToken,
            allowMissing
        });
    } catch (error) {
        logger.error({ err: error }, '❌ Secret Manager client initialization failed.', {
            errorCode: error.code,
            errorMessage: error.message,
            isDev,
            hasLocalRefreshToken,
            allowMissing
        });

        // In local development, allow running without Secret Manager
        if (isDev || hasLocalRefreshToken || allowMissing) {
            logger.warn('🚨 SECRET MANAGER UNAVAILABLE - Running in degraded mode. This is acceptable for development but DANGEROUS for production.', {
                mode: isDev ? 'development' : hasLocalRefreshToken ? 'local-token' : 'allow-missing',
                error: error.message,
                fallback: 'Bot will use local environment variables where available'
            });
            client = null; // Explicitly keep null; callers should handle fallback
            return;
        }

        // In production, this is a critical failure
        logger.fatal('🚨 CRITICAL: Secret Manager initialization failed in production. Bot cannot start safely.', {
            error: error.message,
            errorCode: error.code,
            troubleshooting: 'Ensure: 1) Google Cloud ADC is configured, 2) Service account has Secret Manager permissions, 3) Secret exists and is accessible'
        });
        throw error; // In production, prevent startup if secret manager cannot be initialized
    }
}

/**
 * Gets the initialized Secret Manager client.
 * @returns {SecretManagerServiceClient}
 */
function getSecretManagerClient() {
    if (!client) {
        // This error will be thrown if the client is used before it's initialized.
        // This is a good thing, as it points to a problem in the application's startup logic.
        throw new Error('Secret Manager client has not been initialized. Call initializeSecretManager() first.');
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

    // Check cache first
    if (secretCache.has(secretResourceName)) {
        // logger.debug(`Serving secret from cache: ${secretResourceName.split('/secrets/')[1].split('/')[0]}`);
        return secretCache.get(secretResourceName);
    }

    const smClient = getSecretManagerClient();

    const MAX_RETRIES = 3;
    const TIMEOUT_MS = 10000; // 10 second timeout per attempt
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {

            // Create a timeout promise that rejects after TIMEOUT_MS
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`Secret Manager timeout after ${TIMEOUT_MS}ms`));
                }, TIMEOUT_MS);
            });

            // Race the Secret Manager call against the timeout
            const accessPromise = smClient.accessSecretVersion({
                name: secretResourceName,
            });

            const [version] = await Promise.race([accessPromise, timeoutPromise]);
            const secretValue = decodeSecretPayload(version);

            if (!secretValue) {
                logger.warn('Secret payload data is missing.');
                return null;
            }

            // Cache the value
            secretCache.set(secretResourceName, secretValue);

            return secretValue;
        } catch (error) {
            lastError = error;
            const isTimeout = error.message?.includes('timeout');
            logger.error(
                { err: { code: error.code }, attempt, isTimeout },
                'Failed to access secret version'
            );

            // Retry on DEADLINE_EXCEEDED (4), UNAVAILABLE (14), or timeout
            if ((error.code === 4 || error.code === 14 || isTimeout) && attempt < MAX_RETRIES) {
                const delay = 500 * attempt; // 500ms, 1s (faster retries due to timeout)
                logger.warn(`Retrying secret access in ${delay}ms...`);
                await sleep(delay);
                continue;
            }
            break; // Non-retryable or last attempt
        }
    }

    logger.error({ err: lastError }, `Failed to access secret after ${MAX_RETRIES} attempts.`);
    return null;
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

        // Add a new version to the existing secret
        const [version] = await smClient.addSecretVersion({
            parent: secretResourceName,
            payload: {
                data: Buffer.from(secretValue, 'utf8'),
            },
        });

        logger.info('Successfully added new secret version.');

        // Update cache with the new value
        // Construct the 'latest' version path for this secret
        const latestVersionPath = `${secretResourceName}/versions/latest`;
        secretCache.set(latestVersionPath, secretValue);

        return true;
    } catch (error) {
        logger.error(
            { err: { code: error.code } },
            'Failed to add secret version. Check permissions and secret existence.'
        );
        if (error.code === 5) {
            logger.error('Secret not found.');
        } else if (error.code === 7) {
            logger.error('Permission denied adding secret version. Check IAM roles.');
        }
        return false;
    }
}

// Test helper function to reset client state (only available in test environment)
function resetSecretManagerClient() {
    if (process.env.NODE_ENV === 'test') {
        client = null;
        secretCache.clear();
    }
}

/**
 * Clears the secret cache.
 * Useful for testing or forcing a refresh.
 */
function clearSecretCache() {
    secretCache.clear();
    logger.info('Secret cache cleared.');
}

/**
 * Validates that Secret Manager is properly initialized and working.
 * This should be called after initialization to ensure the client is ready.
 * @returns {boolean} true if Secret Manager is initialized and ready
 */
function validateSecretManager() {
    if (!client) {
        logger.error('❌ Secret Manager validation failed: Client is not initialized');
        return false;
    }

    try {
        // Try to access the client to ensure it's working
        getSecretManagerClient();
        logger.info('✅ Secret Manager validation passed: Client is ready');
        return true;
    } catch (error) {
        logger.error({ err: error }, '❌ Secret Manager validation failed: Client access error');
        return false;
    }
}

/**
 * Gets the current Secret Manager status for monitoring/logging purposes.
 * @returns {object} Status object with initialization state and mode
 */
function getSecretManagerStatus() {
    const isDev = (process.env.NODE_ENV || 'development') === 'development';
    const hasLocalRefreshToken = !!process.env.TWITCH_BOT_REFRESH_TOKEN;
    const allowMissing = process.env.ALLOW_SECRET_MANAGER_MISSING === 'true';

    return {
        initialized: !!client,
        mode: isDev ? 'development' : hasLocalRefreshToken ? 'local-token' : allowMissing ? 'allow-missing' : 'production',
        clientAvailable: !!client,
        environment: process.env.NODE_ENV || 'development',
        hasLocalToken: hasLocalRefreshToken,
        allowMissing: allowMissing,
        cacheSize: secretCache.size
    };
}

export {
    initializeSecretManager,
    getSecretValue,
    setSecretValue,
    resetSecretManagerClient,
    validateSecretManager,
    getSecretManagerStatus,
    clearSecretCache
};