// tests/unit/components/llm/gemini/utils.test.js

import {
    isRetryableError,
    extractTextFromResponse
} from '../../../../../src/components/llm/gemini/utils.js';

describe('gemini/utils.js', () => {
    describe('isRetryableError', () => {
        it('should return true for 503 status', () => {
            expect(isRetryableError({ status: 503 })).toBe(true);
            expect(isRetryableError({ response: { status: 503 } })).toBe(true);
        });

        it('should return true for 429 status', () => {
            expect(isRetryableError({ status: 429 })).toBe(true);
        });

        it('should return true for 500 status', () => {
            expect(isRetryableError({ status: 500 })).toBe(true);
        });

        it('should return true for network errors in message', () => {
            expect(isRetryableError({ message: 'fetch failed' })).toBe(true);
            expect(isRetryableError({ message: 'ECONNRESET' })).toBe(true);
            expect(isRetryableError({ message: 'ETIMEDOUT' })).toBe(true);
        });

        it('should return true for timeout errors in message', () => {
            expect(isRetryableError({ message: 'Service Unavailable' })).toBe(true);
            expect(isRetryableError({ message: 'request timed out' })).toBe(true);
        });

        it('should return false for other errors', () => {
            expect(isRetryableError({ status: 400 })).toBe(false);
            expect(isRetryableError({ message: 'Bad Request' })).toBe(false);
            expect(isRetryableError({})).toBe(false);
        });
    });

    describe('extractTextFromResponse', () => {
        it('should extract text from candidate.text', () => {
            const candidate = { text: 'Hello world' };
            expect(extractTextFromResponse(null, candidate)).toBe('Hello world');
        });

        it('should extract text from response.text() function', () => {
            const response = { text: () => 'Function text' };
            expect(extractTextFromResponse(response, null)).toBe('Function text');
        });

        it('should extract text from candidate parts', () => {
            const candidate = {
                content: {
                    parts: [{ text: 'Part 1' }]
                }
            };
            expect(extractTextFromResponse(null, candidate)).toBe('Part 1');
        });

        it('should combine multiple parts and deduplicate', () => {
            const candidate = {
                content: {
                    parts: [
                        { text: 'Hello world.' },
                        { text: 'Hello world.' },
                        { text: 'How are you?' }
                    ]
                }
            };
            // The logic dedups sentences
            expect(extractTextFromResponse(null, candidate)).toBe('Hello world.');
        });

        it('should return null if no text found', () => {
            expect(extractTextFromResponse({}, {})).toBe(null);
        });
    });
});
