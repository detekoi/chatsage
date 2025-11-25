// tests/unit/components/llm/gemini/decision.test.js

jest.mock('../../../../../src/lib/logger.js');
jest.mock('../../../../../src/components/llm/gemini/core.js');

import { decideSearchWithStructuredOutput } from '../../../../../src/components/llm/gemini/decision.js';
import { getGeminiClient } from '../../../../../src/components/llm/gemini/core.js';

describe('gemini/decision.js', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('decideSearchWithStructuredOutput', () => {
        it('should return false for empty query', async () => {
            const result = await decideSearchWithStructuredOutput('context', '');
            expect(result.searchNeeded).toBe(false);
            expect(result.reasoning).toBe('Empty query');
        });

        it('should use heuristic fallback if LLM call fails', async () => {
            getGeminiClient.mockReturnValue({
                generateContent: jest.fn().mockRejectedValue(new Error('API Error'))
            });

            // "news" triggers the heuristic
            const result = await decideSearchWithStructuredOutput('context', 'latest news');

            expect(result.searchNeeded).toBe(true);
            expect(result.reasoning).toContain('Query contains real-time/news-related keywords');
        });

        it('should parse valid JSON response from LLM', async () => {
            const mockGenerateContent = jest.fn().mockResolvedValue({
                candidates: [{
                    content: {
                        parts: [{ text: JSON.stringify({ searchNeeded: true, reasoning: 'Test reasoning' }) }]
                    }
                }]
            });
            getGeminiClient.mockReturnValue({ generateContent: mockGenerateContent });

            const result = await decideSearchWithStructuredOutput('context', 'some query');

            expect(result.searchNeeded).toBe(true);
            expect(result.reasoning).toBe('Test reasoning');
        });

        it('should handle malformed JSON by falling back to heuristic', async () => {
            const mockGenerateContent = jest.fn().mockResolvedValue({
                candidates: [{
                    content: {
                        parts: [{ text: 'NOT JSON' }]
                    }
                }]
            });
            getGeminiClient.mockReturnValue({ generateContent: mockGenerateContent });

            // "news" triggers heuristic true
            const result = await decideSearchWithStructuredOutput('context', 'news');
            expect(result.searchNeeded).toBe(true);

            // "hello" triggers heuristic false
            const result2 = await decideSearchWithStructuredOutput('context', 'hello');
            expect(result2.searchNeeded).toBe(false);
        });
    });
});
