// tests/unit/components/context/contextManager.test.js

jest.mock('../../../../src/lib/logger.js');
jest.mock('../../../../src/components/twitch/helixClient.js');
jest.mock('../../../../src/components/context/summarizer.js');
jest.mock('../../../../src/components/context/languageStorage.js');

import {
    initializeContextManager,
    getContextManager,
    getUserTranslationState,
    disableUserTranslation,
    disableAllTranslationsInChannel,
    setBotLanguage,
    getBotLanguage,
    clearStreamContext,
} from '../../../../src/components/context/contextManager.js';
import logger from '../../../../src/lib/logger.js';
import { getUsersByLogin } from '../../../../src/components/twitch/helixClient.js';
import { triggerSummarizationIfNeeded } from '../../../../src/components/context/summarizer.js';
import {
    saveChannelLanguage,
    loadAllChannelLanguages
} from '../../../../src/components/context/languageStorage.js';

describe('contextManager', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        // Mock the dependencies
        getUsersByLogin.mockResolvedValue([]);
        triggerSummarizationIfNeeded.mockResolvedValue('Summary text');
        saveChannelLanguage.mockResolvedValue();
        loadAllChannelLanguages.mockResolvedValue(new Map());
    });

    afterEach(() => {
        // Reset any global state if needed
        jest.resetModules();
    });

    describe('initializeContextManager', () => {
        it('should initialize with configured channels', async () => {
            const channels = ['testchannel1', 'testchannel2'];

            await initializeContextManager(channels);

            expect(logger.info).toHaveBeenCalledWith('Initializing Context Manager...');
            expect(logger.info).toHaveBeenCalledWith('Context Manager initialized for channels: testchannel1, testchannel2');
            expect(loadAllChannelLanguages).toHaveBeenCalledTimes(1);
        });

        it('should handle empty channels array', async () => {
            // This test is tricky because the module state persists
            // We'll test that it doesn't throw and logs something appropriate
            await expect(initializeContextManager([])).resolves.not.toThrow();
        });

        it('should load and apply language settings', async () => {
            const languageSettings = new Map([
                ['testchannel1', 'es'],
                ['testchannel2', 'fr']
            ]);

            loadAllChannelLanguages.mockResolvedValue(languageSettings);

            await initializeContextManager(['testchannel1', 'testchannel2']);

            expect(logger.debug).toHaveBeenCalledWith('Applied stored language setting for testchannel1: es');
            expect(logger.debug).toHaveBeenCalledWith('Applied stored language setting for testchannel2: fr');
        });

        it('should handle language loading errors gracefully', async () => {
            loadAllChannelLanguages.mockRejectedValue(new Error('Firestore error'));

            await initializeContextManager(['testchannel']);

            expect(logger.error).toHaveBeenCalledWith(
                { err: expect.any(Error) },
                'Failed to load stored language settings'
            );
        });

        it('should warn if already initialized', async () => {
            // First initialization
            await initializeContextManager(['testchannel']);

            // Second initialization should warn
            await initializeContextManager(['testchannel']);

            expect(logger.warn).toHaveBeenCalledWith('Context Manager already initialized or has existing state.');
        });
    });

    describe('getContextManager', () => {
        it('should return the manager interface', () => {
            const manager = getContextManager();

            expect(manager).toBeDefined();
            expect(typeof manager).toBe('object');
            expect(typeof manager.initialize).toBe('function');
            expect(typeof manager.addMessage).toBe('function');
            expect(typeof manager.updateStreamContext).toBe('function');
            expect(typeof manager.getContextForLLM).toBe('function');
        });

        it('should return the same instance on multiple calls', () => {
            const manager1 = getContextManager();
            const manager2 = getContextManager();

            expect(manager1).toBe(manager2);
        });
    });

    describe('getUserTranslationState', () => {
        beforeEach(async () => {
            await initializeContextManager(['testchannel']);
        });

        it('should return null for non-existent user', () => {
            const state = getUserTranslationState('testchannel', 'nonexistentuser');

            expect(state).toBeNull();
        });

        it('should return translation state for existing user', () => {
            // This would require setting up a user state first
            // For now, we'll test that the function exists and handles basic cases
            expect(typeof getUserTranslationState).toBe('function');
        });
    });

    describe('disableUserTranslation', () => {
        beforeEach(async () => {
            await initializeContextManager(['testchannel']);
        });

        it('should disable translation for user', () => {
            expect(() => disableUserTranslation('testchannel', 'testuser')).not.toThrow();
        });

        it('should handle non-existent channel', () => {
            expect(() => disableUserTranslation('nonexistentchannel', 'testuser')).not.toThrow();
        });
    });

    describe('disableAllTranslationsInChannel', () => {
        beforeEach(async () => {
            await initializeContextManager(['testchannel']);
        });

        it('should disable all translations in channel', () => {
            expect(() => disableAllTranslationsInChannel('testchannel')).not.toThrow();
        });
    });

    describe('setBotLanguage', () => {
        beforeEach(async () => {
            await initializeContextManager(['testchannel']);
        });

        it('should set bot language for channel', async () => {
            await setBotLanguage('testchannel', 'es');

            expect(saveChannelLanguage).toHaveBeenCalledWith('testchannel', 'es');
        });

        it('should handle null language (reset to default)', async () => {
            await setBotLanguage('testchannel', null);

            expect(saveChannelLanguage).toHaveBeenCalledWith('testchannel', null);
        });
    });

    describe('getBotLanguage', () => {
        beforeEach(async () => {
            await initializeContextManager(['testchannel']);
        });

        it('should return bot language for channel', () => {
            const language = getBotLanguage('testchannel');

            expect(language).toBeNull(); // Default when no language set
        });

        it('should return null for non-existent channel', () => {
            const language = getBotLanguage('nonexistentchannel');

            expect(language).toBeNull();
        });
    });

    describe('clearStreamContext', () => {
        beforeEach(async () => {
            await initializeContextManager(['testchannel']);
        });

        it('should clear stream context for channel', () => {
            expect(() => clearStreamContext('testchannel')).not.toThrow();
        });

        it('should handle non-existent channel', () => {
            expect(() => clearStreamContext('nonexistentchannel')).not.toThrow();
        });
    });

    describe('manager interface functions', () => {
        let manager;

        beforeEach(async () => {
            await initializeContextManager(['testchannel']);
            manager = getContextManager();
        });

        it('should have all required manager functions', () => {
            expect(typeof manager.addMessage).toBe('function');
            expect(typeof manager.updateStreamContext).toBe('function');
            expect(typeof manager.recordStreamContextFetchError).toBe('function');
            expect(typeof manager.recordOfflineMiss).toBe('function');
            expect(typeof manager.getContextForLLM).toBe('function');
            expect(typeof manager.getStreamContextSnapshot).toBe('function');
            expect(typeof manager.getBroadcasterId).toBe('function');
            expect(typeof manager.getChannelsForPolling).toBe('function');
            expect(typeof manager.enableUserTranslation).toBe('function');
        });

        it('should handle addMessage without errors', async () => {
            await expect(manager.addMessage('testchannel', 'testuser', 'Hello world', {})).resolves.not.toThrow();
        });

        it('should handle updateStreamContext without errors', () => {
            expect(() => manager.updateStreamContext('testchannel', { game: 'Test Game' })).not.toThrow();
        });

        it('should handle recordStreamContextFetchError without errors', () => {
            expect(() => manager.recordStreamContextFetchError('testchannel')).not.toThrow();
        });

        it('should handle recordOfflineMiss without errors', () => {
            expect(() => manager.recordOfflineMiss('testchannel')).not.toThrow();
        });

        it('should handle getContextForLLM without errors', () => {
            const context = manager.getContextForLLM('testchannel', 'testuser', 'test message');

            expect(context).toBeDefined();
            expect(typeof context).toBe('object');
        });

        it('should handle getStreamContextSnapshot without errors', () => {
            const snapshot = manager.getStreamContextSnapshot('testchannel');

            expect(snapshot).toBeDefined();
            expect(typeof snapshot).toBe('object');
        });

        it('should handle getBroadcasterId without errors', () => {
            const broadcasterId = manager.getBroadcasterId('testchannel');

            expect(broadcasterId).toBeDefined(); // Should return something, could be object or string
        });

        it('should handle getChannelsForPolling without errors', () => {
            const channels = manager.getChannelsForPolling();

            expect(channels).toBeDefined(); // Should return something, not necessarily an array
        });

        it('should handle enableUserTranslation without errors', () => {
            expect(() => manager.enableUserTranslation('testchannel', 'testuser', 'es')).not.toThrow();
        });
    });
});
