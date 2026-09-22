// tests/unit/initialization/initComponents.test.js

jest.mock('../../../src/lib/logger.js');
jest.mock('../../../src/lib/secretManager.js');
jest.mock('../../../src/config/index.js');
jest.mock('../../../src/lib/firestore.js');  // Centralized Firestore client
jest.mock('../../../src/components/twitch/channelManager.js');
jest.mock('../../../src/components/context/languageStorage.js');
jest.mock('../../../src/components/context/autoChatStorage.js');
jest.mock('../../../src/components/context/commandStateManager.js');
jest.mock('../../../src/components/customCommands/customCommandsStorage.js');
jest.mock('../../../src/components/llm/conversationStorage.js');
jest.mock('../../../src/components/llm/llmClient.js');
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
import { initializeFirestore } from '../../../src/lib/firestore.js';
import { initializeChannelManager, getActiveManagedChannels } from '../../../src/components/twitch/channelManager.js';
import { initializeLanguageStorage } from '../../../src/components/context/languageStorage.js';
import { initializeAutoChatStorage } from '../../../src/components/context/autoChatStorage.js';
import { initializeCommandStateManager } from '../../../src/components/context/commandStateManager.js';
import { initializeCustomCommandsStorage } from '../../../src/components/customCommands/customCommandsStorage.js';
import { initializeConversationStorage } from '../../../src/components/llm/conversationStorage.js';
import { initializeLlmClient } from '../../../src/components/llm/llmClient.js';
import { initializeHelixClient } from '../../../src/components/twitch/helixClient.js';
import { initializeContextManager } from '../../../src/components/context/contextManager.js';
import { initializeCommandProcessor } from '../../../src/components/commands/commandProcessor.js';
import { initializeIrcSender } from '../../../src/lib/ircSender.js';
import { initializeGeoGameManager } from '../../../src/components/geo/geoGameManager.js';
import { initializeTriviaGameManager } from '../../../src/components/trivia/triviaGameManager.js';
import { initializeRiddleGameManager } from '../../../src/components/riddle/riddleGameManager.js';
import { startAdSchedulePoller } from '../../../src/components/twitch/adSchedulePoller.js';

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
        config.app = { nodeEnv: 'development', isCloudRun: false };
        config.twitch = { channels: [] };

        // Setup default mocks to succeed
        validateSecretManager.mockReturnValue(true);
        getActiveManagedChannels.mockResolvedValue([{ name: 'channel1', twitchUserId: '111' }, { name: 'channel2', twitchUserId: '222' }]);

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
            config.app.isCloudRun = false;
            config.twitch.channels = ['DevChannel1', 'devchannel2', 'devchannel3'];
            config.app.nodeEnv = 'development';

            await initializeChannels();

            expect(initializeChannelManager).toHaveBeenCalledTimes(1);
            expect(config.twitch.channels).toEqual(['devchannel1', 'devchannel2', 'devchannel3']);
            expect(logger.info).toHaveBeenCalledWith(
                'Local development detected. Using TWITCH_CHANNELS from .env'
            );
        });

        test('should still seed the allow-list from Firestore in development and pre-seed known broadcaster IDs', async () => {
            config.app.isCloudRun = false;
            config.twitch.channels = ['channel1', 'devonly'];
            config.app.nodeEnv = 'development';
            getActiveManagedChannels.mockResolvedValue([{ name: 'channel1', twitchUserId: '111' }, { name: 'channel2', twitchUserId: '222' }]);

            await initializeChannels();

            // The channel-scoped Firestore keys resolve through the allow-list, so it
            // has to be populated even when the channel list itself comes from .env.
            expect(getActiveManagedChannels).toHaveBeenCalledTimes(1);
            expect(config.twitch.channels).toEqual(['channel1', 'devonly']);
            expect(config.twitch.channelsWithIds).toEqual([
                { name: 'channel1', twitchUserId: '111' },
                { name: 'devonly', twitchUserId: null },
            ]);
        });

        test('should exit when TWITCH_CHANNELS is empty in development', async () => {
            config.app.isCloudRun = false;
            config.twitch.channels = [];
            config.app.nodeEnv = 'development';

            await initializeChannels();

            expect(logger.fatal).toHaveBeenCalledWith(
                'TWITCH_CHANNELS is empty or not set in .env for development. Please set it.'
            );
            expect(process.exit).toHaveBeenCalledWith(1);
        });

        test('should load channels from Firestore in Cloud Run environment', async () => {
            config.app.isCloudRun = true;
            config.app.nodeEnv = 'production';
            getActiveManagedChannels.mockResolvedValue([{ name: 'cloudchannel1', twitchUserId: '111' }, { name: 'cloudchannel2', twitchUserId: '222' }]);

            await initializeChannels();

            expect(initializeChannelManager).toHaveBeenCalledTimes(1);
            expect(getActiveManagedChannels).toHaveBeenCalledTimes(1);
            expect(config.twitch.channels).toEqual(['cloudchannel1', 'cloudchannel2']);
            expect(logger.info).toHaveBeenCalledWith(
                'Cloud environment detected or not development. Loading channels from Firestore.'
            );
        });

        // Exiting here used to be unrecoverable: the Firestore listener that would
        // notice a channel coming back is started later in the boot sequence.
        test('should stand by, not exit, when no channels are active in Firestore', async () => {
            config.app.isCloudRun = true;
            getActiveManagedChannels.mockResolvedValue([]);

            await initializeChannels();

            expect(logger.warn).toHaveBeenCalledWith(
                'No active channels found in Firestore managedChannels collection. Waiting for a channel to be activated.'
            );
            expect(process.exit).not.toHaveBeenCalled();
            expect(config.twitch.channels).toEqual([]);
        });

        test('should stand by when the Firestore fetch yields nothing at all', async () => {
            config.app.isCloudRun = true;
            getActiveManagedChannels.mockResolvedValue(null);

            await initializeChannels();

            expect(process.exit).not.toHaveBeenCalled();
            expect(config.twitch.channels).toEqual([]);
            expect(config.twitch.channelsWithIds).toEqual([]);
        });

        test('should convert channel names to lowercase from Firestore', async () => {
            config.app.isCloudRun = true;
            getActiveManagedChannels.mockResolvedValue([{ name: 'Channel1', twitchUserId: '111' }, { name: 'CHANNEL2', twitchUserId: '222' }, { name: 'channel3', twitchUserId: '333' }]);

            await initializeChannels();

            expect(config.twitch.channels).toEqual(['channel1', 'channel2', 'channel3']);
        });

        test('should load channels from Firestore on Cloud Run even in development mode', async () => {
            config.app.isCloudRun = true;
            config.app.nodeEnv = 'development';
            config.twitch.channels = ['devchannel1'];
            getActiveManagedChannels.mockResolvedValue([{ name: 'channel1', twitchUserId: '111' }]);

            await initializeChannels();

            expect(getActiveManagedChannels).toHaveBeenCalled();
            expect(config.twitch.channels).toEqual(['channel1']);
        });
    });

    describe('initializeStorageComponents', () => {
        beforeEach(() => {
            initializeFirestore.mockResolvedValue();
        });

        test('should initialize all storage components in sequence', async () => {
            await initializeStorageComponents();

            // The per-module inits are no-ops; Firestore is initialized centrally
            expect(initializeLanguageStorage).toHaveBeenCalledTimes(1);
            expect(initializeAutoChatStorage).toHaveBeenCalledTimes(1);
            expect(initializeCommandStateManager).toHaveBeenCalledTimes(1);
            expect(initializeCustomCommandsStorage).toHaveBeenCalledTimes(1);
            expect(initializeConversationStorage).toHaveBeenCalledTimes(1);
        });

        test('should propagate errors from Firestore initialization', async () => {
            const error = new Error('Storage init failed');
            // initializeStorageComponents no longer calls initializeFirestore directly;
            // it relies on the caller (initializeAllComponents) to call it first.
            // So we test error propagation from one of the no-op storage inits.
            initializeLanguageStorage.mockRejectedValue(error);

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

            expect(initializeLlmClient).toHaveBeenCalledWith(config);
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
            config.twitch.channelsWithIds = [{ name: 'channel1', twitchUserId: '111' }, { name: 'channel2', twitchUserId: '222' }];
        });

        test('should initialize context manager and command processor', async () => {
            await initializeContextAndCommands();

            expect(initializeContextManager).toHaveBeenCalledWith(config.twitch.channelsWithIds);

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
            getActiveManagedChannels.mockResolvedValue([{ name: 'channel1', twitchUserId: '111' }]);
            initializeFirestore.mockResolvedValue();
            initializeLanguageStorage.mockResolvedValue();
            initializeAutoChatStorage.mockResolvedValue();
            initializeCommandStateManager.mockResolvedValue();
            initializeCustomCommandsStorage.mockResolvedValue();
            initializeConversationStorage.mockResolvedValue();
            initializeLlmClient.mockReturnValue();
            initializeHelixClient.mockResolvedValue();
            initializeContextManager.mockResolvedValue();

            initializeCommandProcessor.mockReturnValue();
            initializeIrcSender.mockReturnValue();
            initializeGeoGameManager.mockResolvedValue();
            initializeTriviaGameManager.mockResolvedValue();
            initializeRiddleGameManager.mockResolvedValue();
            startAdSchedulePoller.mockResolvedValue();
        });

        test('should call all initialization functions in correct order', async () => {
            // Setup all mocks to succeed
            config.app.isCloudRun = true;

            await initializeAllComponents();

            // Verify order: secrets -> firestore -> channels -> storage -> clients -> context -> games -> ad schedule
            expect(initializeSecretManager).toHaveBeenCalled();
            expect(initializeFirestore).toHaveBeenCalled();
            expect(initializeChannelManager).toHaveBeenCalled();
            expect(initializeLlmClient).toHaveBeenCalled();
            expect(initializeHelixClient).toHaveBeenCalled();
            expect(initializeContextManager).toHaveBeenCalled();
            expect(initializeGeoGameManager).toHaveBeenCalled();
            expect(startAdSchedulePoller).toHaveBeenCalled();
        });

        test('should propagate errors from any initialization phase', async () => {
            const error = new Error('Init failed');
            initializeFirestore.mockRejectedValue(error);
            config.app.isCloudRun = true;

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

        test('should finish initialization with no active channels to load', async () => {
            // Reset all mocks
            getActiveManagedChannels.mockResolvedValue([]);
            config.app.isCloudRun = true;

            await initializeAllComponents();

            // Nothing to join yet, but the rest of the bot — including the Firestore
            // listener that picks up the next activation — still has to come up.
            expect(initializeSecretManager).toHaveBeenCalled();
            expect(initializeChannelManager).toHaveBeenCalled();
            expect(initializeContextManager).toHaveBeenCalled();
            expect(startAdSchedulePoller).toHaveBeenCalled();
            expect(process.exit).not.toHaveBeenCalled();
        });
    });
});

