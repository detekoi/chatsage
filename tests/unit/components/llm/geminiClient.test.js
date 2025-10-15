// tests/unit/components/llm/geminiClient.test.js

jest.mock('../../../../src/lib/logger.js');

import {
    buildContextPrompt
} from '../../../../src/components/llm/geminiClient.js';

describe('geminiClient utility functions', () => {
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
            expect(prompt).toContain('Recent messages: user1: hello\nuser2: hi');
        });

        it('should handle missing context fields gracefully', () => {
            const context = {};

            const prompt = buildContextPrompt(context);

            expect(prompt).toContain('Channel: N/A');
            expect(prompt).toContain('Game: N/A');
            expect(prompt).toContain('Title: N/A');
            expect(prompt).toContain('Tags: N/A');
            expect(prompt).toContain('Chat summary: No summary available.');
            expect(prompt).toContain('Recent messages: No recent messages.');
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
            const geminiClient = require('../../../../src/components/llm/geminiClient.js');

            expect(typeof geminiClient.initializeGeminiClient).toBe('function');
            expect(typeof geminiClient.getGenAIInstance).toBe('function');
            expect(typeof geminiClient.getGeminiClient).toBe('function');
            expect(typeof geminiClient.getOrCreateChatSession).toBe('function');
            expect(typeof geminiClient.resetChatSession).toBe('function');
            expect(typeof geminiClient.buildContextPrompt).toBe('function');
            expect(typeof geminiClient.generateStandardResponse).toBe('function');
            expect(typeof geminiClient.generateSearchResponse).toBe('function');
            expect(typeof geminiClient.generateUnifiedResponse).toBe('function');
            expect(typeof geminiClient.decideSearchWithFunctionCalling).toBe('function');
            expect(typeof geminiClient.decideSearchWithStructuredOutput).toBe('function');
            expect(typeof geminiClient.summarizeText).toBe('function');
        });

        it('should have proper function signatures for key functions', () => {
            const geminiClient = require('../../../../src/components/llm/geminiClient.js');

            // Test that buildContextPrompt has the expected signature
            expect(geminiClient.buildContextPrompt.length).toBe(1); // context

            // Test that key async functions exist and are functions
            expect(typeof geminiClient.summarizeText).toBe('function');
            expect(typeof geminiClient.generateStandardResponse).toBe('function');
            expect(typeof geminiClient.generateSearchResponse).toBe('function');
        });
    });
});
