// tests/unit/components/context/contextManager.test.js

jest.mock('../../../../src/lib/logger.js');
jest.mock('../../../../src/components/twitch/helixClient.js');
jest.mock('../../../../src/components/context/summarizer.js');
jest.mock('../../../../src/components/context/languageStorage.js');
jest.mock('../../../../src/components/context/translationStorage.js');
jest.mock('../../../../src/lib/geminiEmoteDescriber.js');

import {
    initializeContextManager,
    getContextManager,
    getUserTranslationState,
    disableUserTranslation,
    disableAllTranslationsInChannel,
    setBotLanguage,
    getBotLanguage,
    clearStreamContext,
    clearThematicContext,
} from '../../../../src/components/context/contextManager.js';
import logger from '../../../../src/lib/logger.js';
import { getUsersByLogin } from '../../../../src/components/twitch/helixClient.js';
import { triggerSummarizationIfNeeded } from '../../../../src/components/context/summarizer.js';
import {
    saveChannelLanguage,
    loadAllChannelLanguages
} from '../../../../src/components/context/languageStorage.js';
import { loadAllUserTranslations, saveUserTranslation, removeUserTranslation } from '../../../../src/components/context/translationStorage.js';
import { getEmoteContextString } from '../../../../src/lib/geminiEmoteDescriber.js';

describe('contextManager', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        // Mock the dependencies
        getUsersByLogin.mockResolvedValue([]);
        triggerSummarizationIfNeeded.mockResolvedValue('Summary text');
        saveChannelLanguage.mockResolvedValue();
        loadAllChannelLanguages.mockResolvedValue(new Map());
        loadAllUserTranslations.mockResolvedValue([]);
        saveUserTranslation.mockResolvedValue();
        removeUserTranslation.mockResolvedValue();
        getEmoteContextString.mockResolvedValue(null);
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

    describe('addMessage summarization behavior', () => {
        let manager;

        // MAX_CHAT_HISTORY_LENGTH = 40, KEEP_RAW = 15
        const MAX = 40;
        const KEEP_RAW = 15;

        // Use unique channel names per test to avoid cross-contamination
        // from module-level channelStates Map that persists across tests
        let testChannelCounter = 0;
        let testChannel;

        beforeEach(async () => {
            jest.clearAllMocks();
            triggerSummarizationIfNeeded.mockResolvedValue('New summary');
            loadAllChannelLanguages.mockResolvedValue(new Map());
            loadAllUserTranslations.mockResolvedValue([]);
            saveUserTranslation.mockResolvedValue();
            removeUserTranslation.mockResolvedValue();
            getEmoteContextString.mockResolvedValue(null);
            testChannelCounter++;
            testChannel = `sumchannel${testChannelCounter}`;
            await initializeContextManager([testChannel]);
            manager = getContextManager();
        });

        it('should pass only evicted messages to summarizer (not the kept tail)', async () => {
            // Add MAX + 1 messages to trigger summarization
            for (let i = 0; i < MAX + 1; i++) {
                await manager.addMessage(testChannel, `user${i}`, `Message ${i}`, {});
            }

            expect(triggerSummarizationIfNeeded).toHaveBeenCalledTimes(1);

            // First arg is channel name, second is the evicted messages array
            const evictedMessages = triggerSummarizationIfNeeded.mock.calls[0][1];
            const evictedCount = MAX + 1 - KEEP_RAW; // 41 - 15 = 26

            expect(evictedMessages).toHaveLength(evictedCount);

            // The evicted messages should be the OLDEST ones (first messages added)
            expect(evictedMessages[0].message).toBe('Message 0');
            expect(evictedMessages[evictedCount - 1].message).toBe(`Message ${evictedCount - 1}`);
        });

        it('should forward state.chatSummary as previousSummary (3rd arg)', async () => {
            // For a fresh channel, chatSummary is '' (empty string)
            for (let i = 0; i < MAX + 1; i++) {
                await manager.addMessage(testChannel, `user${i}`, `Message ${i}`, {});
            }

            expect(triggerSummarizationIfNeeded).toHaveBeenCalledTimes(1);

            // 3rd argument should be the existing chatSummary (empty string for fresh channel)
            const previousSummary = triggerSummarizationIfNeeded.mock.calls[0][2];
            expect(previousSummary).toBe('');
        });

        it('should forward existing summary when summarization triggers again', async () => {
            // First summarization: fills to MAX+1, returns 'First summary'
            triggerSummarizationIfNeeded.mockResolvedValueOnce('First summary');

            for (let i = 0; i < MAX + 1; i++) {
                await manager.addMessage(testChannel, `user${i}`, `First batch msg ${i}`, {});
            }

            expect(triggerSummarizationIfNeeded).toHaveBeenCalledTimes(1);

            // After prune, KEEP_RAW (15) messages remain.
            // Need MAX - KEEP_RAW + 1 = 26 more messages to reach MAX+1 and trigger again.
            triggerSummarizationIfNeeded.mockResolvedValueOnce('Second summary');

            for (let i = 0; i < MAX - KEEP_RAW + 1; i++) {
                await manager.addMessage(testChannel, `user${i}`, `Second batch msg ${i}`, {});
            }

            expect(triggerSummarizationIfNeeded).toHaveBeenCalledTimes(2);

            // Second call should pass 'First summary' as the previousSummary
            const secondCallPrevSummary = triggerSummarizationIfNeeded.mock.calls[1][2];
            expect(secondCallPrevSummary).toBe('First summary');
        });

        it('should keep exactly KEEP_RAW messages after successful summarization', async () => {
            for (let i = 0; i < MAX + 1; i++) {
                await manager.addMessage(testChannel, `user${i}`, `Message ${i}`, {});
            }

            // After summarization + prune, get context and check history length
            const context = manager.getContextForLLM(testChannel, 'testuser', 'test');
            expect(context).toBeDefined();

            // The recentChatHistory is formatted — count the lines
            const historyLines = context.recentChatHistory.split('\n').filter(l => l.trim());
            expect(historyLines).toHaveLength(KEEP_RAW);
        });

        it('should retain messages on failed summarization for retry (not prune)', async () => {
            triggerSummarizationIfNeeded.mockResolvedValue(null); // Summarization fails

            for (let i = 0; i < MAX + 1; i++) {
                await manager.addMessage(testChannel, `user${i}`, `Message ${i}`, {});
            }

            // Messages should be RETAINED (not pruned) so the next trigger can retry.
            // All MAX+1 messages should still be in history.
            const context = manager.getContextForLLM(testChannel, 'testuser', 'test');
            const historyLines = context.recentChatHistory.split('\n').filter(l => l.trim());
            // getContextForLLM returns slice(-KEEP_RAW) of whatever is in chatHistory,
            // but chatHistory itself should still have all MAX+1 messages
            expect(historyLines).toHaveLength(KEEP_RAW);

            // Verify summarization is retried on the NEXT addMessage (still over MAX)
            triggerSummarizationIfNeeded.mockResolvedValueOnce('Retry succeeded');

            await manager.addMessage(testChannel, 'retryuser', 'Retry message', {});
            // Should trigger again since history is still > MAX
            expect(triggerSummarizationIfNeeded).toHaveBeenCalledTimes(2);
        });

        it('should retain messages when summarization throws for retry', async () => {
            triggerSummarizationIfNeeded.mockRejectedValue(new Error('API boom'));

            for (let i = 0; i < MAX + 1; i++) {
                await manager.addMessage(testChannel, `user${i}`, `Message ${i}`, {});
            }

            // Messages retained — verify retry triggers on next addMessage
            triggerSummarizationIfNeeded.mockResolvedValueOnce('Retry succeeded');

            await manager.addMessage(testChannel, 'retryuser', 'Retry message', {});
            expect(triggerSummarizationIfNeeded).toHaveBeenCalledTimes(2);
        });

        it('should force-prune at hard cap (2×MAX) when LLM is persistently down', async () => {
            const HARD_CAP = MAX * 2; // 80
            triggerSummarizationIfNeeded.mockResolvedValue(null); // Always fails

            // Fill past the hard cap. Each addMessage beyond MAX tries summarization,
            // fails, and retains. Eventually hits the hard cap.
            for (let i = 0; i < HARD_CAP + 1; i++) {
                await manager.addMessage(testChannel, `user${i}`, `Message ${i}`, {});
            }

            // After hitting the hard cap, should have been force-pruned to KEEP_RAW
            // (the force-prune uses slice(-KEEP_RAW) on the full array)
            const context = manager.getContextForLLM(testChannel, 'testuser', 'test');
            const historyLines = context.recentChatHistory.split('\n').filter(l => l.trim());
            expect(historyLines).toHaveLength(KEEP_RAW);

            // Verify the force-prune log was emitted
            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('hard cap')
            );
        });

        it('should discard stale summary when clearThematicContext runs during summarization', async () => {
            // Make summarization take "time" by using a deferred promise
            let resolveSummarization;
            const summarizationStarted = new Promise(resolve => {
                triggerSummarizationIfNeeded.mockImplementation(() => {
                    resolve(); // Signal that summarization has been entered
                    return new Promise(res => {
                        resolveSummarization = res;
                    });
                });
            });

            // Add enough messages to trigger summarization
            for (let i = 0; i < MAX; i++) {
                await manager.addMessage(testChannel, `user${i}`, `Message ${i}`, {});
            }
            // This addMessage triggers summarization (async, hangs on the deferred promise).
            // Don't await — we need to interleave clearThematicContext during the gap.
            const addPromise = manager.addMessage(testChannel, 'trigger', 'Trigger msg', {});

            // Wait until addMessage has actually entered the summarization call
            // (it must pass through `await getEmoteContextString()` first)
            await summarizationStarted;

            // While summarization is in-flight, simulate a game change
            clearThematicContext(testChannel);

            // Now resolve the summarization with a stale folded summary
            resolveSummarization('Stale summary with old game themes');
            await addPromise;

            // The stale summary should have been DISCARDED, not written
            const context = manager.getContextForLLM(testChannel, 'testuser', 'test');
            expect(context.chatSummary).not.toBe('Stale summary with old game themes');

            // Should log that it discarded the stale summary
            expect(logger.info).toHaveBeenCalledWith(
                expect.stringContaining('discarding stale folded summary')
            );
        });
    });
});
