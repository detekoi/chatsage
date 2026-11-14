// tests/unit/components/geo/geoClueService.deslop.test.js
// Generated game text goes through the De-Slop cleanup for channels that have it on.

jest.mock('../../../../src/lib/logger.js');
jest.mock('../../../../src/components/llm/llmClient.js', () => ({
    generateStructuredJson: jest.fn(),
}));
jest.mock('../../../../src/components/llm/gemini/prompts.js', () => ({
    buildGameSystemInstruction: jest.fn(() => 'system'),
}));
jest.mock('../../../../src/components/llm/llmRequestLog.js', () => ({
    withLlmCaller: jest.fn((_name, fn) => fn()),
}));
jest.mock('../../../../src/components/context/responseStyleStorage.js', () => ({
    isDeslopEnabled: jest.fn(() => false),
    isDeslopEnabledById: jest.fn(() => false),
}));

import { generateInitialClue, generateFollowUpClue, generateFinalReveal } from '../../../../src/components/geo/geoClueService.js';
import { generateStructuredJson } from '../../../../src/components/llm/llmClient.js';
import { isDeslopEnabled } from '../../../../src/components/context/responseStyleStorage.js';

const RAW = 'A cold harbor — gulls overhead.';
const CLEAN = 'A cold harbor, gulls overhead.';

describe('geoClueService De-Slop cleanup', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        isDeslopEnabled.mockImplementation(name => name === 'plainchannel');
        generateStructuredJson.mockResolvedValue({ clue_text: RAW, reveal_text: RAW });
    });

    test('cleans clues and the reveal for a channel with the switch on', async () => {
        expect(await generateInitialClue('Bergen', 'normal', 'real', null, null, 'plainchannel')).toBe(CLEAN);
        expect(await generateFollowUpClue('Bergen', [], 'real', null, 2, [], null, 'plainchannel')).toBe(CLEAN);
        expect(await generateFinalReveal('Bergen', 'real', null, 'guessed', null, 'plainchannel')).toBe(CLEAN);
    });

    test('leaves the text as generated for a channel with the switch off', async () => {
        expect(await generateInitialClue('Bergen', 'normal', 'real', null, null, 'otherchannel')).toBe(RAW);
        expect(await generateFinalReveal('Bergen', 'real', null, 'guessed', null, 'otherchannel')).toBe(RAW);
    });

    test('still returns null when the model returns no text', async () => {
        generateStructuredJson.mockResolvedValue({});
        expect(await generateInitialClue('Bergen', 'normal', 'real', null, null, 'plainchannel')).toBeNull();
        expect(await generateFinalReveal('Bergen', 'real', null, 'guessed', null, 'plainchannel')).toBeNull();
    });
});
