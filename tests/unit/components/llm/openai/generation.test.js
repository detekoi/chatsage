import { initializeOpenAiClient, getOpenAiInstance } from '../../../../../src/components/llm/openai/core.js';
import {
    generateStandardResponse,
    generateSearchResponse,
    fetchIanaTimezoneForLocation
} from '../../../../../src/components/llm/openai/generation.js';

describe('OpenAI Generation Module', () => {
    beforeAll(() => {
        initializeOpenAiClient({ apiKey: 'test-key', modelId: 'gpt-5.6-luna' });
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('generateStandardResponse returns text response', async () => {
        const instance = getOpenAiInstance();
        jest.spyOn(instance.responses, 'create').mockResolvedValueOnce({
            output_text: 'Standard bot response.'
        });

        const res = await generateStandardResponse('Context', 'Hi');
        expect(res).toBe('Standard bot response.');
    });

    test('generateStandardResponse handles function tool calling loop', async () => {
        const instance = getOpenAiInstance();
        jest.spyOn(instance.responses, 'create')
            .mockResolvedValueOnce({
                id: 'resp_1',
                output: [{
                    type: 'function_call',
                    call_id: 'call_1',
                    name: 'getCurrentTime',
                    arguments: JSON.stringify({ timezone: 'UTC' })
                }]
            })
            .mockResolvedValueOnce({
                output_text: 'The current time in UTC is 12:00 PM.'
            });

        const res = await generateStandardResponse('Context', 'What time is it in UTC?');
        expect(res).toBe('The current time in UTC is 12:00 PM.');
    });

    test('generateSearchResponse includes web_search tool and returns text', async () => {
        const instance = getOpenAiInstance();
        const spy = jest.spyOn(instance.responses, 'create').mockResolvedValueOnce({
            output_text: 'Grounded search response.',
            output: [{ type: 'web_search_call', query: 'weather today' }]
        });

        const res = await generateSearchResponse('Context', 'weather today');
        expect(res).toBe('Grounded search response.');
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({
            tools: [{ type: 'web_search' }]
        }));
    });

    test('fetchIanaTimezoneForLocation returns timezone string', async () => {
        const instance = getOpenAiInstance();
        jest.spyOn(instance.responses, 'create').mockResolvedValueOnce({
            output_parsed: { iana_timezone: 'America/New_York' }
        });

        const tz = await fetchIanaTimezoneForLocation('New York');
        expect(tz).toBe('America/New_York');
    });
});
