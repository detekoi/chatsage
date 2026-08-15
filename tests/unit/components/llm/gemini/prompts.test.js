// tests/unit/components/llm/gemini/prompts.test.js

import {
    buildContextPrompt,
    CHAT_SAGE_SYSTEM_INSTRUCTION
} from '../../../../../src/components/llm/gemini/prompts.js';

describe('gemini/prompts.js', () => {
    describe('CHAT_SAGE_SYSTEM_INSTRUCTION', () => {
        it('should be a non-empty string', () => {
            expect(typeof CHAT_SAGE_SYSTEM_INSTRUCTION).toBe('string');
            expect(CHAT_SAGE_SYSTEM_INSTRUCTION.length).toBeGreaterThan(0);
        });

        it('should contain key persona traits', () => {
            expect(CHAT_SAGE_SYSTEM_INSTRUCTION).toContain('WildcatSage');
            expect(CHAT_SAGE_SYSTEM_INSTRUCTION).toContain('witty and knowledgeable');
        });
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

        it('should render pronouns as inflected forms, not the display label', () => {
            const context = {
                channelName: 'testchannel',
                username: 'TurboIceHusky',
                userPronouns: {
                    display: 'He/Him',
                    grammar: { display: 'He/Him', subject: 'he', object: 'him', possessive: 'his' }
                }
            };

            const prompt = buildContextPrompt(context);

            expect(prompt).toContain('Pronoun grammar for TurboIceHusky: use he/him/his for third-person references.');
            // The display label must never appear — that is what leaked into chat.
            expect(prompt).not.toContain('He/Him');
        });

        it('should omit the pronoun line when no grammar forms are available', () => {
            const prompt = buildContextPrompt({
                channelName: 'testchannel',
                username: 'someuser',
                userPronouns: { display: 'He/Him' }
            });

            expect(prompt).not.toContain('Pronoun grammar');
        });

        it('should omit the pronoun line when the user has no pronouns set', () => {
            const prompt = buildContextPrompt({ channelName: 'testchannel', username: 'someuser' });

            expect(prompt).not.toContain('Pronoun grammar');
        });
    });
});

