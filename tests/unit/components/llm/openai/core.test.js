import {
    initializeOpenAiClient,
    getOpenAiInstance,
    getConfiguredModelId,
    formatOpenAiContent,
    generateLiteContent
} from '../../../../../src/components/llm/openai/core.js';

describe('OpenAI Core Module', () => {
    describe('Initialization', () => {
        test('should throw error when initialized without apiKey', () => {
            expect(() => initializeOpenAiClient({})).toThrow(/Missing required OpenAI configuration/);
        });

        test('should initialize successfully with apiKey', () => {
            initializeOpenAiClient({ apiKey: 'test-key', modelId: 'gpt-5.6-luna' });
            expect(getOpenAiInstance()).toBeDefined();
            expect(getConfiguredModelId()).toBe('gpt-5.6-luna');
        });
    });

    describe('formatOpenAiContent', () => {
        test('should format text and image parts correctly', () => {
            const parts = [
                { text: 'Look at this' },
                { inlineData: { mimeType: 'image/png', data: 'abc123base64' } }
            ];

            const formatted = formatOpenAiContent('User query', parts);
            expect(formatted).toEqual([
                { type: 'input_text', text: 'User query' },
                { type: 'input_text', text: 'Look at this' },
                { type: 'input_image', image_url: 'data:image/png;base64,abc123base64' }
            ]);
        });
    });

    describe('generateLiteContent', () => {
        test('should execute responses.create and extract output_text', async () => {
            const instance = getOpenAiInstance();
            jest.spyOn(instance.responses, 'create').mockResolvedValueOnce({
                output_text: 'Test completion text'
            });

            const result = await generateLiteContent('Hello');
            expect(result).toBe('Test completion text');
        });

        test('should return null on content refusal', async () => {
            const instance = getOpenAiInstance();
            jest.spyOn(instance.responses, 'create').mockResolvedValueOnce({
                output: [{ type: 'refusal', refusal: 'Safety policy violation' }]
            });

            const result = await generateLiteContent('Unsafe query');
            expect(result).toBeNull();
        });
    });
});
