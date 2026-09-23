import { initializeOpenAiClient, getOpenAiInstance } from '../../../../../src/components/llm/openai/core.js';
import {
    generateStandardResponse,
    generateSearchResponse,
    fetchIanaTimezoneForLocation
} from '../../../../../src/components/llm/openai/generation.js';

describe('OpenAI Generation Module', () => {
    beforeAll(() => {
        initializeOpenAiClient({ apiKey: 'test-key', modelId: 'gpt-6-luna' });
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

    test('generateStandardResponse follows chained function calls across rounds', async () => {
        const instance = getOpenAiInstance();
        const spy = jest.spyOn(instance.responses, 'create')
            .mockResolvedValueOnce({
                id: 'resp_1',
                output: [{
                    type: 'function_call',
                    call_id: 'call_1',
                    name: 'get_iana_timezone_for_location_tool',
                    arguments: JSON.stringify({ location_name: 'Paris' })
                }]
            })
            // fetchIanaTimezoneForLocation's own lookup call
            .mockResolvedValueOnce({ output_text: JSON.stringify({ iana_timezone: 'Europe/Paris' }) })
            .mockResolvedValueOnce({
                id: 'resp_2',
                output: [{
                    type: 'function_call',
                    call_id: 'call_2',
                    name: 'getCurrentTime',
                    arguments: JSON.stringify({ timezone: 'Europe/Paris' })
                }]
            })
            .mockResolvedValueOnce({ id: 'resp_3', output_text: 'It is 2:00 AM in Paris.' });

        const res = await generateStandardResponse('Context', 'What time is it in Paris?');
        expect(res).toBe('It is 2:00 AM in Paris.');
        const finalPayload = spy.mock.calls[3][0];
        expect(finalPayload.previous_response_id).toBe('resp_2');
        expect(finalPayload.input).toEqual([expect.objectContaining({ type: 'function_call_output', call_id: 'call_2' })]);
    });

    test('generateStandardResponse answers every parallel function call', async () => {
        const instance = getOpenAiInstance();
        const spy = jest.spyOn(instance.responses, 'create')
            .mockResolvedValueOnce({
                id: 'resp_1',
                output: [
                    { type: 'function_call', call_id: 'a', name: 'getCurrentTime', arguments: JSON.stringify({ timezone: 'UTC' }) },
                    { type: 'function_call', call_id: 'b', name: 'getCurrentTime', arguments: JSON.stringify({ timezone: 'Asia/Tokyo' }) }
                ]
            })
            .mockResolvedValueOnce({ id: 'resp_2', output_text: 'Times listed.' });

        const res = await generateStandardResponse('Context', 'Time in UTC and Tokyo?');
        expect(res).toBe('Times listed.');
        expect(spy.mock.calls[1][0].input.map(i => i.call_id)).toEqual(['a', 'b']);
    });

    test('generateStandardResponse adds web_search alongside function tools when webSearch is set', async () => {
        const instance = getOpenAiInstance();
        const spy = jest.spyOn(instance.responses, 'create').mockResolvedValueOnce({
            output_text: 'Grounded answer.',
            output: [{ type: 'web_search_call', query: 'weather today' }]
        });

        const res = await generateStandardResponse('Context', 'weather today', { webSearch: true });
        expect(res).toBe('Grounded answer.');
        const { tools } = spy.mock.calls[0][0];
        expect(tools).toContainEqual({ type: 'web_search' });
        expect(tools).toContainEqual(expect.objectContaining({ name: 'getCurrentTime' }));
    });

    test('generateStandardResponse omits web_search by default', async () => {
        const instance = getOpenAiInstance();
        const spy = jest.spyOn(instance.responses, 'create').mockResolvedValueOnce({
            output_text: 'Standard bot response.'
        });

        await generateStandardResponse('Context', 'Hi');
        expect(spy.mock.calls[0][0].tools).not.toContainEqual({ type: 'web_search' });
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
