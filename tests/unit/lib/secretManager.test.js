// tests/unit/lib/secretManager.test.js

jest.mock('@google-cloud/secret-manager');
jest.mock('../../../src/lib/logger.js');

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import * as secretManager from '../../../src/lib/secretManager.js';
import logger from '../../../src/lib/logger.js';

const {
    initializeSecretManager,
    getSecretManagerClient,
    getSecretValue,
    setSecretValue
} = secretManager;

describe('secretManager', () => {
    let mockClient;

    beforeEach(() => {
        jest.clearAllMocks();

        // Mock the SecretManagerServiceClient constructor
        mockClient = {
            accessSecretVersion: jest.fn(),
            addSecretVersion: jest.fn(),
        };

        SecretManagerServiceClient.mockImplementation(() => mockClient);

        // Mock process.env for tests
        process.env.NODE_ENV = 'test';
        delete process.env.TWITCH_BOT_REFRESH_TOKEN;
        delete process.env.ALLOW_SECRET_MANAGER_MISSING;
    });

    afterEach(() => {
        // Clean up process.env
        delete process.env.NODE_ENV;
        delete process.env.TWITCH_BOT_REFRESH_TOKEN;
        delete process.env.ALLOW_SECRET_MANAGER_MISSING;
    });

    describe('initializeSecretManager', () => {
        it('should initialize client successfully', () => {
            initializeSecretManager();

            expect(SecretManagerServiceClient).toHaveBeenCalledTimes(1);
            expect(logger.info).toHaveBeenCalledWith('Initializing Google Cloud Secret Manager client...');
            expect(logger.info).toHaveBeenCalledWith('Secret Manager client initialized successfully.');
        });

        it('should not reinitialize if already initialized', () => {
            initializeSecretManager();
            initializeSecretManager(); // Second call

            expect(SecretManagerServiceClient).toHaveBeenCalledTimes(1);
            expect(logger.warn).toHaveBeenCalledWith('Secret Manager client already initialized.');
        });

        it('should handle initialization errors in production', () => {
            const error = new Error('GCP credentials error');
            SecretManagerServiceClient.mockImplementation(() => {
                throw error;
            });

            // Set production environment
            process.env.NODE_ENV = 'production';

            expect(() => initializeSecretManager()).toThrow(error);
            expect(logger.fatal).toHaveBeenCalledWith({ err: error }, 'Failed to initialize Secret Manager client. Ensure ADC or credentials are configured.');
        });

        it('should handle initialization errors gracefully in development', () => {
            const error = new Error('GCP credentials error');
            SecretManagerServiceClient.mockImplementation(() => {
                throw error;
            });

            // Set development environment
            process.env.NODE_ENV = 'development';

            expect(() => initializeSecretManager()).not.toThrow();
            expect(logger.warn).toHaveBeenCalledWith(
                { err: { message: error.message } },
                'Secret Manager client init failed. Continuing without Secret Manager (dev/local token mode).'
            );
        });

        it('should handle initialization errors gracefully in development with local token', () => {
            const error = new Error('GCP credentials error');
            SecretManagerServiceClient.mockImplementation(() => {
                throw error;
            });

            // Set development environment with local token
            process.env.NODE_ENV = 'development';
            process.env.TWITCH_BOT_REFRESH_TOKEN = 'test-token';

            expect(() => initializeSecretManager()).not.toThrow();
            expect(logger.warn).toHaveBeenCalledWith(
                { err: { message: error.message } },
                'Secret Manager client init failed. Continuing without Secret Manager (dev/local token mode).'
            );
        });

        it('should handle initialization errors gracefully when ALLOW_SECRET_MANAGER_MISSING is set', () => {
            const error = new Error('GCP credentials error');
            SecretManagerServiceClient.mockImplementation(() => {
                throw error;
            });

            // Set flag to allow missing secret manager
            process.env.ALLOW_SECRET_MANAGER_MISSING = 'true';

            expect(() => initializeSecretManager()).not.toThrow();
            expect(logger.warn).toHaveBeenCalledWith(
                { err: { message: error.message } },
                'Secret Manager client init failed. Continuing without Secret Manager (dev/local token mode).'
            );
        });
    });

    describe('getSecretManagerClient', () => {
        it('should return client when initialized', () => {
            initializeSecretManager();

            const client = getSecretManagerClient();
            expect(client).toBe(mockClient);
        });

        it('should lazy initialize when called before explicit initialization', () => {
            const client = getSecretManagerClient();

            expect(client).toBe(mockClient);
            expect(logger.warn).toHaveBeenCalledWith('Secret Manager client accessed before explicit initialization. Attempting lazy init.');
            expect(SecretManagerServiceClient).toHaveBeenCalledTimes(1);
        });

        it('should throw error when lazy initialization fails', () => {
            SecretManagerServiceClient.mockImplementation(() => {
                throw new Error('Init failed');
            });

            expect(() => getSecretManagerClient()).toThrow('Secret Manager client could not be initialized.');
        });
    });

    describe('getSecretValue', () => {
        beforeEach(() => {
            initializeSecretManager();
        });

        it('should return null for empty secret name', async () => {
            const result = await getSecretValue('');

            expect(result).toBeNull();
            expect(logger.error).toHaveBeenCalledWith('getSecretValue called with empty secretResourceName.');
        });

        it('should retrieve secret value successfully', async () => {
            const mockVersion = {
                payload: {
                    data: Buffer.from('test-secret-value', 'utf8')
                }
            };

            mockClient.accessSecretVersion.mockResolvedValue([mockVersion]);

            const result = await getSecretValue('projects/test/secrets/test-secret/versions/latest');

            expect(result).toBe('test-secret-value');
            expect(mockClient.accessSecretVersion).toHaveBeenCalledWith({
                name: 'projects/test/secrets/test-secret/versions/latest'
            });
            expect(logger.info).toHaveBeenCalledWith('Successfully retrieved secret: test-secret');
        });

        it('should return null when secret payload is missing', async () => {
            const mockVersion = {
                payload: null
            };

            mockClient.accessSecretVersion.mockResolvedValue([mockVersion]);

            const result = await getSecretValue('projects/test/secrets/test-secret/versions/latest');

            expect(result).toBeNull();
            expect(logger.warn).toHaveBeenCalledWith('Secret payload data is missing for projects/test/secrets/test-secret/versions/latest.');
        });

        it('should retry on retryable errors', async () => {
            const retryableError = new Error('Deadline exceeded');
            retryableError.code = 4; // DEADLINE_EXCEEDED

            mockClient.accessSecretVersion
                .mockRejectedValueOnce(retryableError)
                .mockRejectedValueOnce(retryableError)
                .mockResolvedValue([{
                    payload: {
                        data: Buffer.from('success-after-retry', 'utf8')
                    }
                }]);

            const result = await getSecretValue('projects/test/secrets/test-secret/versions/latest');

            expect(result).toBe('success-after-retry');
            expect(mockClient.accessSecretVersion).toHaveBeenCalledTimes(3);
        });

        it('should return null after max retries on non-retryable error', async () => {
            const nonRetryableError = new Error('Not found');
            nonRetryableError.code = 5; // NOT_FOUND

            mockClient.accessSecretVersion.mockRejectedValue(nonRetryableError);

            const result = await getSecretValue('projects/test/secrets/test-secret/versions/latest');

            expect(result).toBeNull();
            expect(mockClient.accessSecretVersion).toHaveBeenCalledTimes(3);
            expect(logger.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    err: nonRetryableError,
                    secretName: 'projects/test/secrets/test-secret/versions/latest'
                }),
                expect.stringContaining('Failed to access secret version after 3 attempts')
            );
        });

        it('should not retry on non-retryable errors', async () => {
            const nonRetryableError = new Error('Permission denied');
            nonRetryableError.code = 7; // PERMISSION_DENIED

            mockClient.accessSecretVersion.mockRejectedValue(nonRetryableError);

            const result = await getSecretValue('projects/test/secrets/test-secret/versions/latest');

            expect(result).toBeNull();
            expect(mockClient.accessSecretVersion).toHaveBeenCalledTimes(1); // Only one attempt
        });
    });

    describe('setSecretValue', () => {
        beforeEach(() => {
            initializeSecretManager();
        });

        it('should return false for empty secret name', async () => {
            const result = await setSecretValue('', 'value');

            expect(result).toBe(false);
            expect(logger.error).toHaveBeenCalledWith('setSecretValue called with empty secretResourceName or secretValue.');
        });

        it('should return false for empty secret value', async () => {
            const result = await setSecretValue('projects/test/secrets/test-secret', '');

            expect(result).toBe(false);
            expect(logger.error).toHaveBeenCalledWith('setSecretValue called with empty secretResourceName or secretValue.');
        });

        it('should add secret version successfully', async () => {
            const mockVersion = {
                name: 'projects/test/secrets/test-secret/versions/2'
            };

            mockClient.addSecretVersion.mockResolvedValue([mockVersion]);

            const result = await setSecretValue('projects/test/secrets/test-secret', 'new-secret-value');

            expect(result).toBe(true);
            expect(mockClient.addSecretVersion).toHaveBeenCalledWith({
                parent: 'projects/test/secrets/test-secret',
                payload: {
                    data: Buffer.from('new-secret-value', 'utf8')
                }
            });
            expect(logger.info).toHaveBeenCalledWith('Successfully added new version to secret: test-secret (version: 2)');
        });

        it('should handle errors when adding secret version', async () => {
            const error = new Error('Secret not found');
            error.code = 5; // NOT_FOUND

            mockClient.addSecretVersion.mockRejectedValue(error);

            const result = await setSecretValue('projects/test/secrets/test-secret', 'new-secret-value');

            expect(result).toBe(false);
            expect(logger.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    err: { message: error.message, code: error.code },
                    secretName: 'projects/test/secrets/test-secret'
                }),
                expect.stringContaining('Failed to add version to secret')
            );
        });

        it('should log specific error messages for common error codes', async () => {
            const notFoundError = new Error('Secret not found');
            notFoundError.code = 5; // NOT_FOUND

            mockClient.addSecretVersion.mockRejectedValue(notFoundError);

            await setSecretValue('projects/test/secrets/test-secret', 'new-secret-value');

            expect(logger.error).toHaveBeenCalledWith('Secret not found: projects/test/secrets/test-secret');
        });
    });
});
