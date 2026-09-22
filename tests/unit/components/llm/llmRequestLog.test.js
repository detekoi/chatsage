jest.mock('../../../../src/lib/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }
}));

import logger from '../../../../src/lib/logger.js';
import {
    withLlmCaller,
    getLlmCaller,
    instrumentOpenAiClient,
    instrumentGenAiClient
} from '../../../../src/components/llm/llmRequestLog.js';

describe('llmRequestLog', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('withLlmCaller', () => {
        test('outermost wrapper is caller, innermost is op', async () => {
            const seen = await withLlmCaller('cmd.ask', () =>
                withLlmCaller('translate', async () => getLlmCaller())
            );
            expect(seen).toEqual({ caller: 'cmd.ask', op: 'translate' });
        });

        test('returns null outside any wrapper', () => {
            expect(getLlmCaller()).toBeNull();
        });
    });

    describe('instrumentOpenAiClient', () => {
        test('logs one completed line with model, tier, tools and token usage', async () => {
            const create = jest.fn().mockResolvedValue({
                output_text: 'hi',
                usage: {
                    input_tokens: 120,
                    output_tokens: 30,
                    input_tokens_details: { cached_tokens: 100 },
                    output_tokens_details: { reasoning_tokens: 5 }
                }
            });
            const client = instrumentOpenAiClient({ responses: { create } });

            const payload = {
                model: 'gpt-5.6-luna',
                input: 'hello',
                service_tier: 'flex',
                tools: [{ type: 'web_search' }],
                text: { format: { type: 'json_schema' } },
                reasoning: { effort: 'low' }
            };
            const result = await withLlmCaller('checkin', () => client.responses.create(payload, { timeout: 5 }));

            expect(result.output_text).toBe('hi');
            expect(create).toHaveBeenCalledWith(payload, { timeout: 5 });
            expect(logger.info).toHaveBeenCalledTimes(1);
            const [fields, message] = logger.info.mock.calls[0];
            expect(message).toBe('[LLM] Request completed');
            expect(fields).toMatchObject({
                provider: 'openai',
                model: 'gpt-5.6-luna',
                caller: 'checkin',
                op: 'checkin',
                serviceTier: 'flex',
                tools: ['web_search'],
                structured: true,
                reasoningEffort: 'low',
                inputTokens: 120,
                cachedTokens: 100,
                outputTokens: 30,
                reasoningTokens: 5
            });
            expect(typeof fields.durationMs).toBe('number');
        });

        test('logs a failed line per attempt and rethrows', async () => {
            const error = Object.assign(new Error('rate limited'), { status: 429 });
            const create = jest.fn().mockRejectedValue(error);
            const client = instrumentOpenAiClient({ responses: { create } });

            await expect(client.responses.create({ model: 'gpt-5.6-luna' })).rejects.toBe(error);
            expect(logger.info).not.toHaveBeenCalled();
            expect(logger.warn).toHaveBeenCalledTimes(1);
            const [fields, message] = logger.warn.mock.calls[0];
            expect(message).toBe('[LLM] Request failed');
            expect(fields).toMatchObject({ provider: 'openai', model: 'gpt-5.6-luna', status: 429, caller: null });
        });

        test('leaves a client without responses.create untouched', () => {
            const client = {};
            expect(instrumentOpenAiClient(client)).toBe(client);
        });
    });

    describe('instrumentGenAiClient', () => {
        test('logs one completed line with model, tier, tools and token usage', async () => {
            const generateContent = jest.fn().mockResolvedValue({
                text: 'ok',
                usageMetadata: {
                    promptTokenCount: 80,
                    candidatesTokenCount: 20,
                    cachedContentTokenCount: 10,
                    thoughtsTokenCount: 3
                }
            });
            const genAI = instrumentGenAiClient({ models: { generateContent } });

            const payload = {
                model: 'gemini-flash-lite-latest',
                contents: [],
                config: {
                    serviceTier: 'flex',
                    tools: [{ googleSearch: {} }],
                    responseMimeType: 'application/json',
                    thinkingConfig: { thinkingLevel: 'low' }
                }
            };
            const result = await withLlmCaller('translate', () => genAI.models.generateContent(payload));

            expect(result.text).toBe('ok');
            expect(generateContent).toHaveBeenCalledWith(payload);
            expect(logger.info).toHaveBeenCalledTimes(1);
            const [fields, message] = logger.info.mock.calls[0];
            expect(message).toBe('[LLM] Request completed');
            expect(fields).toMatchObject({
                provider: 'gemini',
                model: 'gemini-flash-lite-latest',
                caller: 'translate',
                serviceTier: 'flex',
                tools: ['googleSearch'],
                structured: true,
                thinkingLevel: 'low',
                inputTokens: 80,
                cachedTokens: 10,
                outputTokens: 20,
                reasoningTokens: 3
            });
        });

        test('logs a failed line and rethrows', async () => {
            const error = Object.assign(new Error('unavailable'), { status: 503 });
            const generateContent = jest.fn().mockRejectedValue(error);
            const genAI = instrumentGenAiClient({ models: { generateContent } });

            await expect(genAI.models.generateContent({ model: 'gemini-flash-lite-latest' })).rejects.toBe(error);
            expect(logger.warn).toHaveBeenCalledTimes(1);
            expect(logger.warn.mock.calls[0][0]).toMatchObject({ provider: 'gemini', status: 503 });
        });
    });
});
