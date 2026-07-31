import { safeExtractText, safeParseJsonResponse } from '../../../../../src/components/llm/openai/utils.js';

describe('OpenAI Utils Module', () => {
    describe('safeExtractText', () => {
        test('should return null for null/undefined input', () => {
            expect(safeExtractText(null)).toBeNull();
            expect(safeExtractText(undefined)).toBeNull();
        });

        test('should extract direct output_text string', () => {
            const res = { output_text: '   Hello World   ' };
            expect(safeExtractText(res)).toBe('Hello World');
        });

        test('should extract text from output message array', () => {
            const res = {
                output: [
                    {
                        type: 'message',
                        content: [{ type: 'text', text: 'Output part 1' }]
                    }
                ]
            };
            expect(safeExtractText(res)).toBe('Output part 1');
        });

        test('should return null on refusal', () => {
            const res = {
                output: [{ type: 'refusal', refusal: 'Blocked' }]
            };
            expect(safeExtractText(res)).toBeNull();
        });
    });

    describe('safeParseJsonResponse', () => {
        test('should prefer output_parsed if available', () => {
            const res = {
                output_parsed: { success: true },
                output_text: '{"success":false}'
            };
            expect(safeParseJsonResponse(res)).toEqual({ success: true });
        });

        test('should parse output_text string when output_parsed is absent', () => {
            const res = { output_text: '{"foo":"bar"}' };
            expect(safeParseJsonResponse(res)).toEqual({ foo: 'bar' });
        });

        test('should return null on invalid JSON string', () => {
            const res = { output_text: 'Not JSON' };
            expect(safeParseJsonResponse(res)).toBeNull();
        });
    });
});
