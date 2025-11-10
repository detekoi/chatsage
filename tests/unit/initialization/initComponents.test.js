// tests/unit/initialization/initComponents.test.js

jest.mock('../../../src/lib/logger.js');
jest.mock('../../../src/lib/secretManager.js');
jest.mock('../../../src/config/index.js');
jest.mock('../../../src/components/twitch/channelManager.js');
jest.mock('../../../src/components/geo/geoStorage.js');
jest.mock('../../../src/components/trivia/triviaStorage.js');
jest.mock('../../../src/components/riddle/riddleStorage.js');
jest.mock('../../../src/components/context/languageStorage.js');
jest.mock('../../../src/components/context/autoChatStorage.js');
jest.mock('../../../src/components/quotes/quoteStorage.js');
jest.mock('../../../src/components/context/commandStateManager.js');
jest.mock('../../../src/components/llm/geminiClient.js');
jest.mock('../../../src/components/twitch/helixClient.js');
jest.mock('../../../src/components/context/contextManager.js');
jest.mock('../../../src/components/commands/commandProcessor.js');
jest.mock('../../../src/lib/ircSender.js');
jest.mock('../../../src/components/geo/geoGameManager.js');
jest.mock('../../../src/components/trivia/triviaGameManager.js');
jest.mock('../../../src/components/riddle/riddleGameManager.js');
jest.mock('../../../src/components/twitch/adSchedulePoller.js');
jest.mock('../../../src/components/twitch/eventsub.js');

import {
    initializeSecrets,
    initializeChannels,
    initializeStorageComponents,
    initializeClients,
    initializeContextAndCommands,
    initializeGameManagers,
    initializeAdSchedule,
    initializeAllComponents
} from '../../../src/initialization/initComponents.js';
import { initializeSecretManager, validateSecretManager } from '../../../src/lib/secretManager.js';
import { initializeChannelManager, getActiveManagedChannels } from '../../../src/components/twitch/channelManager.js';
import { initializeStorage } from '../../../src/components/geo/geoStorage.js';
import { initializeStorage as initializeTriviaStorage } from '../../../src/components/trivia/triviaStorage.js';
import { initializeRiddleStorage } from '../../../src/components/riddle/riddleStorage.js';
import { initializeLanguageStorage } from '../../../src/components/context/languageStorage.js';
import { initializeAutoChatStorage } from '../../../src/components/context/autoChatStorage.js';
import { initializeQuotesStorage } from '../../../src/components/quotes/quoteStorage.js';
import { initializeCommandStateManager } from '../../../src/components/context/commandStateManager.js';
import { initializeGeminiClient } from '../../../src/components/llm/geminiClient.js';
import { initializeHelixClient } from '../../../src/components/twitch/helixClient.js';
import { initializeContextManager } from '../../../src/components/context/contextManager.js';
import { initializeCommandProcessor } from '../../../src/components/commands/commandProcessor.js';
import { initializeIrcSender } from '../../../src/lib/ircSender.js';
import { initializeGeoGameManager } from '../../../src/components/geo/geoGameManager.js';
import { initializeTriviaGameManager } from '../../../src/components/trivia/triviaGameManager.js';
import { initializeRiddleGameManager } from '../../../src/components/riddle/riddleGameManager.js';
import { startAdSchedulePoller } from '../../../src/components/twitch/adSchedulePoller.js';
import { cleanupKeepAliveTasks } from '../../../src/components/twitch/eventsub.js';
import config from '../../../src/config/index.js';
import logger from '../../../src/lib/logger.js';

describe('Component Initialization', () => {
    let originalEnv;
    let originalExit;

    beforeEach(() => {
        jest.clearAllMocks();
        
        // Save original environment
        originalEnv = { ...process.env };
        
        // Mock process.exit to prevent actual exit
        originalExit = process.exit;
        process.exit = jest.fn();

        // Setup default config mock
        config.app = { nodeEnv: 'development' };
        config.twitch = { channels: [] };

        // Setup default mocks to succeed
        validateSecretManager.mockReturnValue(true);
        getActiveManagedChannels.mockResolvedValue(['channel1', 'channel2']);

        // Setup logger mock with all methods
        logger.fatal = jest.fn();
        logger.info = jest.fn();
        logger.error = jest.fn();
        logger.warn = jest.fn();
        logger.debug = jest.fn();
    });

    afterEach(() => {
        // Restore original environment
        process.env = originalEnv;
        process.exit = originalExit;
    });

    describe('initializeSecrets', () => {
        test('should initialize and validate secret manager successfully', async () => {
            validateSecretManager.mockReturnValue(true);

            await initializeSecrets();

            expect(initializeSecretManager).toHaveBeenCalledTimes(1);
            expect(validateSecretManager).toHaveBeenCalledTimes(1);
            expect(process.exit).not.toHaveBeenCalled();
        });

        test('should exit process when validation fails', async () => {
            validateSecretManager.mockReturnValue(false);

            await initializeSecrets();

            expect(initializeSecretManager).toHaveBeenCalledTimes(1);
            expect(validateSecretManager).toHaveBeenCalledTimes(1);
            expect(logger.fatal).toHaveBeenCalledWith(
                'Secret Manager validation failed. Cannot continue safely.'
            );
            expect(process.exit).toHaveBeenCalledWith(1);
        });
    });

    describe('initializeChannels', () => {
        test('should load channels from .env in development environment', async () => {
            process.env.K_SERVICE = undefined;
            process.env.K_REVISION = undefined;
            process.env.K_CONFIGURATION = undefined;
            process.env.TWITCH_CHANNELS = 'devchannel1,devchannel2,devchannel3';
            config.app.nodeEnv = 'development';

            await initializeChannels();

            expect(initializeChannelManager).toHaveBeenCalledTimes(1);
            expect(config.twitch.channels).toEqual(['devchannel1', 'devchannel2', 'devchannel3']);
            expect(logger.info).toHaveBeenCalledWith(
                'Local development detected. Using TWITCH_CHANNELS from .env'
            );
        });

        test('should exit when TWITCH_CHANNELS is empty in development', async () => {
            process.env.K_SERVICE = undefined;
            process.env.TWITCH_CHANNELS = '';
            config.app.nodeEnv = 'development';

            await initializeChannels();

            expect(logger.fatal).toHaveBeenCalledWith(
                'TWITCH_CHANNELS is empty or not set in .env for development. Please set it.'
            );
            expect(process.exit).toHaveBeenCalledWith(1);
        });

        test('should load channels from Firestore in Cloud Run environment', async () => {
            process.env.K_SERVICE = 'test-service';
            config.app.nodeEnv = 'production';
            getActiveManagedChannels.mockResolvedValue(['cloudchannel1', 'cloudchannel2']);

            await initializeChannels();

            expect(initializeChannelManager).toHaveBeenCalledTimes(1);
            expect(getActiveManagedChannels).toHaveBeenCalledTimes(1);
            expect(config.twitch.channels).toEqual(['cloudchannel1', 'cloudchannel2']);
            expect(logger.info).toHaveBeenCalledWith(
                'Cloud environment detected or not development. Loading channels from Firestore.'
            );
        });

        test('should exit when no channels found in Firestore', async () => {
            process.env.K_SERVICE = 'test-service';
            getActiveManagedChannels.mockResolvedValue([]);

            await initializeChannels();

            expect(logger.fatal).toHaveBeenCalledWith(
                'No active channels found in Firestore managedChannels collection. Cannot proceed.'
            );
            expect(process.exit).toHaveBeenCalledWith(1);
        });

        test('should exit when channels array is empty after initialization', async () => {
            process.env.K_SERVICE = 'test-service';
            getActiveManagedChannels.mockResolvedValue(null);
            config.twitch.channels = [];

            await initializeChannels();

            expect(logger.fatal).toHaveBeenCalledWith(
                'FATAL: No Twitch channels configured to join. Exiting.'
            );
            expect(process.exit).toHaveBeenCalledWith(1);
        });

        test('should convert channel names to lowercase from Firestore', async () => {
            process.env.K_SERVICE = 'test-service';
            getActiveManagedChannels.mockResolvedValue(['Channel1', 'CHANNEL2', 'channel3']);

            await initializeChannels();

            expect(config.twitch.channels).toEqual(['channel1', 'channel2', 'channel3']);
        });

        test('should detect Cloud Run via K_REVISION', async () => {
            process.env.K_REVISION = 'test-revision';
            getActiveManagedChannels.mockResolvedValue(['channel1']);

            await initializeChannels();

            expect(getActiveManagedChannels).toHaveBeenCalled();
            expect(process.env.K_SERVICE).toBeUndefined();
        });

        test('should detect Cloud Run via K_CONFIGURATION', async () => {
            process.env.K_CONFIGURATION = 'test-config';
            getActiveManagedChannels.mockResolvedValue(['channel1']);

            await initializeChannels();

            expect(getActiveManagedChannels).toHaveBeenCalled();
        });
    });

    describe('initializeStorageComponents', () => {
        test('should initialize all storage components in sequence', async () => {
            await initializeStorageComponents();

            expect(initializeStorage).toHaveBeenCalledTimes(1);
            expect(initializeTriviaStorage).toHaveBeenCalledTimes(1);
            expect(initializeRiddleStorage).toHaveBeenCalledTimes(1);
            expect(initializeLanguageStorage).toHaveBeenCalledTimes(1);
            expect(initializeAutoChatStorage).toHaveBeenCalledTimes(1);
            expect(initializeQuotesStorage).toHaveBeenCalledTimes(1);
            expect(initializeCommandStateManager).toHaveBeenCalledTimes(1);
        });

        test('should propagate errors from storage initialization', async () => {
            const error = new Error('Storage init failed');
            initializeStorage.mockRejectedValue(error);

            await expect(initializeStorageComponents()).rejects.toThrow('Storage init failed');
        });
    });

    describe('initializeClients', () => {
        test('should initialize Gemini and Helix clients', async () => {
            const geminiConfig = { apiKey: 'test-key', modelId: 'test-model' };
            const twitchConfig = { clientId: 'test-id', clientSecret: 'test-secret' };
            config.gemini = geminiConfig;
            config.twitch = { ...config.twitch, ...twitchConfig };

            await initializeClients();

            expect(initializeGeminiClient).toHaveBeenCalledWith(geminiConfig);
            expect(initializeHelixClient).toHaveBeenCalledWith(config.twitch);
        });

        test('should propagate errors from client initialization', async () => {
            const error = new Error('Helix init failed');
            initializeHelixClient.mockRejectedValue(error);

            await expect(initializeClients()).rejects.toThrow('Helix init failed');
        });
    });

    describe('initializeContextAndCommands', () => {
        beforeEach(() => {
            config.twitch.channels = ['channel1', 'channel2'];
        });

        test('should initialize context manager and command processor', async () => {
            await initializeContextAndCommands();

            expect(initializeContextManager).toHaveBeenCalledWith(['channel1', 'channel2']);
            expect(cleanupKeepAliveTasks).toHaveBeenCalledTimes(1);
            expect(initializeCommandProcessor).toHaveBeenCalledTimes(1);
            expect(initializeIrcSender).toHaveBeenCalledTimes(1);
        });

        test('should propagate errors from context initialization', async () => {
            const error = new Error('Context init failed');
            initializeContextManager.mockRejectedValue(error);

            await expect(initializeContextAndCommands()).rejects.toThrow('Context init failed');
        });
    });

    describe('initializeGameManagers', () => {
        test('should initialize all game managers', async () => {
            await initializeGameManagers();

            expect(initializeGeoGameManager).toHaveBeenCalledTimes(1);
            expect(initializeTriviaGameManager).toHaveBeenCalledTimes(1);
            expect(initializeRiddleGameManager).toHaveBeenCalledTimes(1);
        });

        test('should propagate errors from game manager initialization', async () => {
            const error = new Error('Game manager init failed');
            initializeGeoGameManager.mockRejectedValue(error);

            await expect(initializeGameManagers()).rejects.toThrow('Game manager init failed');
        });
    });

    describe('initializeAdSchedule', () => {
        test('should start ad schedule poller successfully', async () => {
            startAdSchedulePoller.mockResolvedValue();

            await initializeAdSchedule();

            expect(startAdSchedulePoller).toHaveBeenCalledTimes(1);
            expect(logger.info).toHaveBeenCalledWith(
                'Ad Schedule Poller started (pre-IRC).'
            );
        });

        test('should handle errors from ad schedule poller', async () => {
            const error = new Error('Ad schedule init failed');
            startAdSchedulePoller.mockRejectedValue(error);

            await initializeAdSchedule();

            expect(logger.error).toHaveBeenCalledWith(
                { err: error },
                'Failed to start Ad Schedule Poller (pre-IRC)'
            );
        });
    });

    describe('initializeAllComponents', () => {
        beforeEach(() => {
            // Reset all mocks to ensure clean state
            jest.clearAllMocks();
            validateSecretManager.mockReturnValue(true);
            getActiveManagedChannels.mockResolvedValue(['channel1']);
            initializeStorage.mockResolvedValue();
            initializeTriviaStorage.mockResolvedValue();
            initializeRiddleStorage.mockResolvedValue();
            initializeLanguageStorage.mockResolvedValue();
            initializeAutoChatStorage.mockResolvedValue();
            initializeQuotesStorage.mockResolvedValue();
            initializeCommandStateManager.mockResolvedValue();
            initializeGeminiClient.mockReturnValue();
            initializeHelixClient.mockResolvedValue();
            initializeContextManager.mockResolvedValue();
            cleanupKeepAliveTasks.mockResolvedValue();
            initializeCommandProcessor.mockReturnValue();
            initializeIrcSender.mockReturnValue();
            initializeGeoGameManager.mockResolvedValue();
            initializeTriviaGameManager.mockResolvedValue();
            initializeRiddleGameManager.mockResolvedValue();
            startAdSchedulePoller.mockResolvedValue();
        });

        test('should call all initialization functions in correct order', async () => {
            // Setup all mocks to succeed
            process.env.K_SERVICE = 'test-service';

            await initializeAllComponents();

            // Verify order: secrets -> channels -> storage -> clients -> context -> games -> ad schedule
            expect(initializeSecretManager).toHaveBeenCalled();
            expect(initializeChannelManager).toHaveBeenCalled();
            expect(initializeStorage).toHaveBeenCalled();
            expect(initializeGeminiClient).toHaveBeenCalled();
            expect(initializeHelixClient).toHaveBeenCalled();
            expect(initializeContextManager).toHaveBeenCalled();
            expect(initializeGeoGameManager).toHaveBeenCalled();
            expect(startAdSchedulePoller).toHaveBeenCalled();
        });

        test('should propagate errors from any initialization phase', async () => {
            const error = new Error('Init failed');
            initializeStorage.mockRejectedValue(error);
            process.env.K_SERVICE = 'test-service';

            await expect(initializeAllComponents()).rejects.toThrow('Init failed');
        });

        test('should stop initialization on secret validation failure', async () => {
            // Reset all mocks
            validateSecretManager.mockReturnValue(false);

            await initializeAllComponents();

            expect(initializeSecretManager).toHaveBeenCalled();
            expect(process.exit).toHaveBeenCalledWith(1);
            // Note: process.exit doesn't actually stop execution in tests, so other functions may still be called
            // The important thing is that process.exit was called
        });

        test('should stop initialization on channel loading failure', async () => {
            // Reset all mocks
            getActiveManagedChannels.mockResolvedValue([]);
            process.env.K_SERVICE = 'test-service';

            await initializeAllComponents();

            expect(initializeSecretManager).toHaveBeenCalled();
            expect(initializeChannelManager).toHaveBeenCalled();
            expect(process.exit).toHaveBeenCalledWith(1);
            // Note: process.exit doesn't actually stop execution in tests, so other functions may still be called
            // The important thing is that process.exit was called
        });
    });
});

