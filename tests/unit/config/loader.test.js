// tests/unit/config/loader.test.js

jest.mock('dotenv');
jest.mock('fs');

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

describe('Config Loader', () => {
    let originalEnv;
    let originalCwd;

    beforeEach(() => {
        // Save original environment
        originalEnv = { ...process.env };
        originalCwd = process.cwd();
        
        // Clear all mocks
        jest.clearAllMocks();
        
        // Reset process.env
        process.env = {};
        
        // Mock fs.existsSync to return false by default
        fs.existsSync.mockReturnValue(false);
        
        // Mock dotenv.config to do nothing
        dotenv.config.mockReturnValue({});
    });

    afterEach(() => {
        // Restore original environment
        process.env = originalEnv;
        process.chdir(originalCwd);
        
        // Clear module cache to force reload
        jest.resetModules();
    });

    describe('Required Environment Variables', () => {
        test('should throw error when TWITCH_BOT_USERNAME is missing', () => {
            process.env.GEMINI_API_KEY = 'test-key';
            process.env.TWITCH_CLIENT_ID = 'test-client-id';
            process.env.TWITCH_CLIENT_SECRET = 'test-secret';
            process.env.TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME = 'test-secret-name';

            expect(() => {
                require('../../../src/config/loader.js');
            }).toThrow(/Missing required environment variables.*TWITCH_BOT_USERNAME/);
        });

        test('should throw error when GEMINI_API_KEY is missing', () => {
            process.env.TWITCH_BOT_USERNAME = 'testbot';
            process.env.TWITCH_CLIENT_ID = 'test-client-id';
            process.env.TWITCH_CLIENT_SECRET = 'test-secret';
            process.env.TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME = 'test-secret-name';

            expect(() => {
                require('../../../src/config/loader.js');
            }).toThrow(/Missing required environment variables.*GEMINI_API_KEY/);
        });

        test('should throw error when TWITCH_CLIENT_ID is missing', () => {
            process.env.TWITCH_BOT_USERNAME = 'testbot';
            process.env.GEMINI_API_KEY = 'test-key';
            process.env.TWITCH_CLIENT_SECRET = 'test-secret';
            process.env.TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME = 'test-secret-name';

            expect(() => {
                require('../../../src/config/loader.js');
            }).toThrow(/Missing required environment variables.*TWITCH_CLIENT_ID/);
        });

        test('should throw error when TWITCH_CLIENT_SECRET is missing', () => {
            process.env.TWITCH_BOT_USERNAME = 'testbot';
            process.env.GEMINI_API_KEY = 'test-key';
            process.env.TWITCH_CLIENT_ID = 'test-client-id';
            process.env.TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME = 'test-secret-name';

            expect(() => {
                require('../../../src/config/loader.js');
            }).toThrow(/Missing required environment variables.*TWITCH_CLIENT_SECRET/);
        });

        test('should require TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME when TWITCH_BOT_REFRESH_TOKEN is not provided', () => {
            process.env.TWITCH_BOT_USERNAME = 'testbot';
            process.env.GEMINI_API_KEY = 'test-key';
            process.env.TWITCH_CLIENT_ID = 'test-client-id';
            process.env.TWITCH_CLIENT_SECRET = 'test-secret';
            // TWITCH_BOT_REFRESH_TOKEN not set, so SECRET_NAME is required

            expect(() => {
                require('../../../src/config/loader.js');
            }).toThrow(/Missing required environment variables.*TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME/);
        });

        test('should not require TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME when TWITCH_BOT_REFRESH_TOKEN is provided', () => {
            process.env.TWITCH_BOT_USERNAME = 'testbot';
            process.env.GEMINI_API_KEY = 'test-key';
            process.env.TWITCH_CLIENT_ID = 'test-client-id';
            process.env.TWITCH_CLIENT_SECRET = 'test-secret';
            process.env.TWITCH_BOT_REFRESH_TOKEN = 'direct-token';
            // SECRET_NAME not required when direct token is provided

            jest.resetModules();
            expect(() => {
                const config = require('../../../src/config/loader.js');
                expect(config.default).toBeDefined();
            }).not.toThrow();
        });
    });

    describe('Default Values', () => {
        beforeEach(() => {
            // Set required env vars before requiring the module
            process.env.TWITCH_BOT_USERNAME = 'testbot';
            process.env.GEMINI_API_KEY = 'test-key';
            process.env.TWITCH_CLIENT_ID = 'test-client-id';
            process.env.TWITCH_CLIENT_SECRET = 'test-secret';
            process.env.TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME = 'test-secret-name';
        });

        test('should use default GEMINI_MODEL_ID when not provided', () => {
            jest.resetModules(); // Clear module cache
            const config = require('../../../src/config/loader.js');
            expect(config.default.gemini.modelId).toBe('gemini-2.5-flash-preview-05-20');
        });

        test('should use custom GEMINI_MODEL_ID when provided', () => {
            process.env.GEMINI_MODEL_ID = 'custom-model-id';
            jest.resetModules(); // Clear module cache
            const config = require('../../../src/config/loader.js');
            expect(config.default.gemini.modelId).toBe('custom-model-id');
        });

        test('should use default log level when not provided', () => {
            jest.resetModules(); // Clear module cache
            const config = require('../../../src/config/loader.js');
            expect(config.default.app.logLevel).toBe('info');
        });

        test('should use custom log level when provided', () => {
            process.env.LOG_LEVEL = 'debug';
            jest.resetModules(); // Clear module cache
            const config = require('../../../src/config/loader.js');
            expect(config.default.app.logLevel).toBe('debug');
        });

        test('should use default nodeEnv when not provided', () => {
            jest.resetModules(); // Clear module cache
            const config = require('../../../src/config/loader.js');
            expect(config.default.app.nodeEnv).toBe('development');
        });

        test('should use custom nodeEnv when provided', () => {
            process.env.NODE_ENV = 'production';
            jest.resetModules(); // Clear module cache
            const config = require('../../../src/config/loader.js');
            expect(config.default.app.nodeEnv).toBe('production');
        });
    });

    describe('Stream Info Polling Interval', () => {
        beforeEach(() => {
            process.env.TWITCH_BOT_USERNAME = 'testbot';
            process.env.GEMINI_API_KEY = 'test-key';
            process.env.TWITCH_CLIENT_ID = 'test-client-id';
            process.env.TWITCH_CLIENT_SECRET = 'test-secret';
            process.env.TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME = 'test-secret-name';
        });

        test('should use default interval when not provided', () => {
            jest.resetModules();
            const config = require('../../../src/config/loader.js');
            expect(config.default.app.streamInfoFetchIntervalMs).toBe(120 * 1000);
        });

        test('should convert seconds to milliseconds', () => {
            process.env.STREAM_INFO_FETCH_INTERVAL_SECONDS = '60';
            jest.resetModules();
            const config = require('../../../src/config/loader.js');
            expect(config.default.app.streamInfoFetchIntervalMs).toBe(60 * 1000);
        });

        test('should handle invalid interval gracefully', () => {
            process.env.STREAM_INFO_FETCH_INTERVAL_SECONDS = 'invalid';
            jest.resetModules();
            const config = require('../../../src/config/loader.js');
            // Should fallback to default
            expect(config.default.app.streamInfoFetchIntervalMs).toBe(120 * 1000);
        });

        test('should handle zero interval gracefully', () => {
            process.env.STREAM_INFO_FETCH_INTERVAL_SECONDS = '0';
            jest.resetModules();
            const config = require('../../../src/config/loader.js');
            // Should fallback to default
            expect(config.default.app.streamInfoFetchIntervalMs).toBe(120 * 1000);
        });
    });

    describe('Channel Configuration', () => {
        beforeEach(() => {
            process.env.TWITCH_BOT_USERNAME = 'testbot';
            process.env.GEMINI_API_KEY = 'test-key';
            process.env.TWITCH_CLIENT_ID = 'test-client-id';
            process.env.TWITCH_CLIENT_SECRET = 'test-secret';
            process.env.TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME = 'test-secret-name';
        });

        test('should parse TWITCH_CHANNELS comma-separated list', () => {
            process.env.TWITCH_CHANNELS = 'channel1,channel2,channel3';
            jest.resetModules();
            const config = require('../../../src/config/loader.js');
            expect(config.default.twitch.channels).toEqual(['channel1', 'channel2', 'channel3']);
        });

        test('should trim whitespace from channel names', () => {
            process.env.TWITCH_CHANNELS = ' channel1 , channel2 , channel3 ';
            jest.resetModules();
            const config = require('../../../src/config/loader.js');
            expect(config.default.twitch.channels).toEqual(['channel1', 'channel2', 'channel3']);
        });

        test('should filter empty channel names', () => {
            process.env.TWITCH_CHANNELS = 'channel1,,channel2,  ,channel3';
            jest.resetModules();
            const config = require('../../../src/config/loader.js');
            expect(config.default.twitch.channels).toEqual(['channel1', 'channel2', 'channel3']);
        });

        test('should return empty array when TWITCH_CHANNELS is not set', () => {
            jest.resetModules();
            const config = require('../../../src/config/loader.js');
            expect(config.default.twitch.channels).toEqual([]);
        });

        test('should parse ALLOWED_CHANNELS and convert to lowercase', () => {
            process.env.ALLOWED_CHANNELS = 'Channel1,Channel2,Channel3';
            jest.resetModules();
            const config = require('../../../src/config/loader.js');
            expect(config.default.app.allowedChannels).toEqual(['channel1', 'channel2', 'channel3']);
        });
    });

    describe('EventSub Secret Handling', () => {
        beforeEach(() => {
            process.env.TWITCH_BOT_USERNAME = 'testbot';
            process.env.GEMINI_API_KEY = 'test-key';
            process.env.TWITCH_CLIENT_ID = 'test-client-id';
            process.env.TWITCH_CLIENT_SECRET = 'test-secret';
            process.env.TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME = 'test-secret-name';
        });

        test('should read secret from file when path exists', () => {
            const secretPath = '/path/to/secret';
            process.env.TWITCH_EVENTSUB_SECRET = secretPath;
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue('secret-content-from-file');

            jest.resetModules();
            jest.clearAllMocks(); // Clear mocks after resetModules
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue('secret-content-from-file');
            const config = require('../../../src/config/loader.js');
            
            expect(fs.existsSync).toHaveBeenCalledWith(secretPath);
            expect(fs.readFileSync).toHaveBeenCalledWith(secretPath, 'utf8');
            expect(config.default.twitch.eventSubSecret).toBe('secret-content-from-file');
        });

        test('should use direct value when file does not exist', () => {
            const secretValue = 'direct-secret-value';
            process.env.TWITCH_EVENTSUB_SECRET = secretValue;
            fs.existsSync.mockReturnValue(false);

            jest.resetModules();
            jest.clearAllMocks(); // Clear mocks after resetModules
            fs.existsSync.mockReturnValue(false);
            const config = require('../../../src/config/loader.js');
            
            expect(fs.existsSync).toHaveBeenCalledWith(secretValue);
            expect(fs.readFileSync).not.toHaveBeenCalled();
            expect(config.default.twitch.eventSubSecret).toBe(secretValue);
        });

        test('should handle missing TWITCH_EVENTSUB_SECRET', () => {
            jest.resetModules();
            const config = require('../../../src/config/loader.js');
            expect(config.default.twitch.eventSubSecret).toBeUndefined();
        });
    });

    describe('Configuration Structure', () => {
        beforeEach(() => {
            process.env.TWITCH_BOT_USERNAME = 'testbot';
            process.env.GEMINI_API_KEY = 'test-key';
            process.env.TWITCH_CLIENT_ID = 'test-client-id';
            process.env.TWITCH_CLIENT_SECRET = 'test-secret';
            process.env.TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME = 'test-secret-name';
        });

        test('should have correct twitch configuration structure', () => {
            process.env.PUBLIC_URL = 'https://example.com';
            jest.resetModules();
            const config = require('../../../src/config/loader.js');
            
            expect(config.default.twitch).toHaveProperty('username', 'testbot');
            expect(config.default.twitch).toHaveProperty('channels');
            expect(config.default.twitch).toHaveProperty('clientId', 'test-client-id');
            expect(config.default.twitch).toHaveProperty('clientSecret', 'test-secret');
            expect(config.default.twitch).toHaveProperty('publicUrl', 'https://example.com');
        });

        test('should have correct gemini configuration structure', () => {
            jest.resetModules();
            const config = require('../../../src/config/loader.js');
            
            expect(config.default.gemini).toHaveProperty('apiKey', 'test-key');
            expect(config.default.gemini).toHaveProperty('modelId');
        });

        test('should have correct app configuration structure', () => {
            jest.resetModules();
            const config = require('../../../src/config/loader.js');
            
            expect(config.default.app).toHaveProperty('streamInfoFetchIntervalMs');
            expect(config.default.app).toHaveProperty('logLevel');
            expect(config.default.app).toHaveProperty('prettyLog');
            expect(config.default.app).toHaveProperty('nodeEnv');
            expect(config.default.app).toHaveProperty('allowedChannels');
        });

        test('should have correct secrets configuration structure', () => {
            process.env.TWITCH_CHANNELS_SECRET_NAME = 'channels-secret';
            process.env.ALLOWED_CHANNELS_SECRET_NAME = 'allowed-secret';
            jest.resetModules();
            const config = require('../../../src/config/loader.js');
            
            expect(config.default.secrets).toHaveProperty('twitchBotRefreshTokenName', 'test-secret-name');
            expect(config.default.secrets).toHaveProperty('twitchChannelsSecretName', 'channels-secret');
            expect(config.default.secrets).toHaveProperty('allowedChannelsSecretName', 'allowed-secret');
        });

        test('should have correct webui configuration structure', () => {
            process.env.WEBUI_BASE_URL = 'https://custom-webui.com';
            process.env.WEBUI_INTERNAL_TOKEN = 'internal-token';
            jest.resetModules();
            const config = require('../../../src/config/loader.js');
            
            expect(config.default.webui).toHaveProperty('baseUrl', 'https://custom-webui.com');
            expect(config.default.webui).toHaveProperty('internalToken', 'internal-token');
        });

        test('should use default webui baseUrl when not provided', () => {
            jest.resetModules();
            const config = require('../../../src/config/loader.js');
            expect(config.default.webui.baseUrl).toBe('https://us-central1-streamsage-bot.cloudfunctions.net');
        });
    });

    describe('.env File Loading', () => {
        beforeEach(() => {
            process.env.TWITCH_BOT_USERNAME = 'testbot';
            process.env.GEMINI_API_KEY = 'test-key';
            process.env.TWITCH_CLIENT_ID = 'test-client-id';
            process.env.TWITCH_CLIENT_SECRET = 'test-secret';
            process.env.TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME = 'test-secret-name';
        });

        test('should load .env file when it exists', () => {
            const envPath = path.resolve(process.cwd(), '.env');
            fs.existsSync.mockReturnValue(true);
            
            jest.resetModules();
            jest.clearAllMocks(); // Clear mocks after resetModules
            fs.existsSync.mockReturnValue(true);
            require('../../../src/config/loader.js');
            
            expect(fs.existsSync).toHaveBeenCalledWith(envPath);
            expect(dotenv.config).toHaveBeenCalledWith({ path: envPath });
        });

        test('should not load .env file when it does not exist', () => {
            fs.existsSync.mockReturnValue(false);
            
            jest.resetModules();
            require('../../../src/config/loader.js');
            
            expect(dotenv.config).not.toHaveBeenCalled();
        });
    });

    describe('Pretty Logging Configuration', () => {
        beforeEach(() => {
            process.env.TWITCH_BOT_USERNAME = 'testbot';
            process.env.GEMINI_API_KEY = 'test-key';
            process.env.TWITCH_CLIENT_ID = 'test-client-id';
            process.env.TWITCH_CLIENT_SECRET = 'test-secret';
            process.env.TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME = 'test-secret-name';
        });

        test('should set prettyLog to false when PINO_PRETTY_LOGGING is not "true"', () => {
            process.env.PINO_PRETTY_LOGGING = 'false';
            jest.resetModules();
            const config = require('../../../src/config/loader.js');
            expect(config.default.app.prettyLog).toBe(false);
        });

        test('should set prettyLog to true when PINO_PRETTY_LOGGING is "true"', () => {
            process.env.PINO_PRETTY_LOGGING = 'true';
            jest.resetModules();
            const config = require('../../../src/config/loader.js');
            expect(config.default.app.prettyLog).toBe(true);
        });

        test('should default prettyLog to false when not set', () => {
            jest.resetModules();
            const config = require('../../../src/config/loader.js');
            expect(config.default.app.prettyLog).toBe(false);
        });
    });
});

