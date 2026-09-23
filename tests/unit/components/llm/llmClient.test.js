// tests/unit/components/llm/llmClient.test.js
if (typeof jest === 'undefined') {
    globalThis.jest = {
        mock: () => {},
        clearAllMocks: () => {},
    };
    globalThis.describe = (name, fn) => fn();
    globalThis.beforeEach = (fn) => fn();
    globalThis.it = (name, fn) => fn();
    globalThis.expect = (val) => ({
        toContain: (str) => {
            if (typeof val !== 'string') {
                throw new Error(`Expected "${val}" to be a string containing "${str}", but got ${typeof val}`);
            }
            if (!val.includes(str)) {
                throw new Error(`Expected "${val}" to contain "${str}"`);
            }
        },
        toBe: (expected) => {
            if (val !== expected) {
                throw new Error(`Expected ${val} to be ${expected}`);
            }
        },
    });
}

jest.mock('../../../../src/lib/logger.js');

import * as llmClient from '../../../../src/components/llm/llmClient.js';

const { buildContextPrompt } = llmClient;

describe('llmClient utility functions', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('buildContextPrompt', () => {
        it('should build context prompt from complete context object', () => {
            const context = {
                channelName: 'testchannel',
                streamGame: 'Test Game',
                streamTitle: 'Test Stream Title',
                streamTags: 'tag1, tag2, tag3',
                chatSummary: 'Recent chat summary',
                recentChatHistory: 'user1: hello\nuser2: hi'
            };

            const prompt = buildContextPrompt(context);

            expect(prompt).toContain('Channel: testchannel');
            expect(prompt).toContain('Game: Test Game');
            expect(prompt).toContain('Title: Test Stream Title');
            expect(prompt).toContain('Tags: tag1, tag2, tag3');
            expect(prompt).toContain('Chat summary: Recent chat summary');
            expect(prompt).toContain('Recent chat messages (each line shows username: message):\nuser1: hello\nuser2: hi');
        });

        it('should handle missing context fields gracefully', () => {
            const context = {};

            const prompt = buildContextPrompt(context);

            expect(prompt).toContain('Channel: N/A');
            expect(prompt).toContain('Game: N/A');
            expect(prompt).toContain('Title: N/A');
            expect(prompt).toContain('Tags: N/A');
            expect(prompt).toContain('Chat summary: No summary available.');
            expect(prompt).toContain('Recent chat messages (each line shows username: message):\nNo recent messages.');
        });

        it('should handle partial context fields', () => {
            const context = {
                channelName: 'testchannel',
                streamGame: 'Test Game'
            };

            const prompt = buildContextPrompt(context);

            expect(prompt).toContain('Channel: testchannel');
            expect(prompt).toContain('Game: Test Game');
            expect(prompt).toContain('Title: N/A');
            expect(prompt).toContain('Tags: N/A');
        });
    });


    describe('module exports', () => {
        it('should export buildContextPrompt function', () => {
            expect(typeof buildContextPrompt).toBe('function');
        });

        it('should export all critical functions', () => {
            // Test that all critical functions exist (even if we don't test them directly due to API complexity)
            expect(typeof llmClient.initializeLlmClient).toBe('function');
            expect(typeof llmClient.getGenAIInstance).toBe('function');
            expect(typeof llmClient.getOrCreateChatSession).toBe('function');
            expect(typeof llmClient.resetChatSession).toBe('function');
            expect(typeof llmClient.buildContextPrompt).toBe('function');
            expect(typeof llmClient.generateStandardResponse).toBe('function');
            expect(typeof llmClient.generateSearchResponse).toBe('function');
            expect(typeof llmClient.generateUnifiedResponse).toBe('function');
            expect(typeof llmClient.summarizeText).toBe('function');
        });

        it('should have proper function signatures for key functions', () => {
            // Test that buildContextPrompt has the expected signature
            expect(llmClient.buildContextPrompt.length).toBe(1); // context

            // Test that key async functions exist and are functions
            expect(typeof llmClient.summarizeText).toBe('function');
            expect(typeof llmClient.generateStandardResponse).toBe('function');
            expect(typeof llmClient.generateSearchResponse).toBe('function');
        });
    });
});
