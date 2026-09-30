// tests/unit/components/llm/gamePersonaPrompts.test.js
// Game content generators voice their text in the channel persona; the calls that
// judge answers or pick locations stay persona-free.

jest.mock('../../../../src/components/context/personaStorage.js', () => ({
    getCachedPersona: jest.fn(),
    getCachedPersonaById: jest.fn(),
}));
jest.mock('../../../../src/components/llm/llmClient.js', () => ({
    generateStructuredJson: jest.fn(),
    generateText: jest.fn(),
}));
jest.mock('../../../../src/components/llm/llmRequestLog.js', () => ({
    withLlmCaller: (_name, fn) => fn(),
}));
jest.mock('../../../../src/components/context/contextManager.js');
jest.mock('../../../../src/lib/logger.js');

import { getCachedPersona } from '../../../../src/components/context/personaStorage.js';
import { generateStructuredJson } from '../../../../src/components/llm/llmClient.js';
import { GAME_CORE_INSTRUCTION, DEFAULT_BOT_PERSONA } from '../../../../src/components/llm/gemini/prompts.js';
import { generateQuestion, verifyAnswer } from '../../../../src/components/trivia/triviaQuestionService.js';
import { generateRiddle, verifyRiddleAnswer } from '../../../../src/components/riddle/riddleService.js';
import { generateInitialClue, generateFollowUpClue, generateFinalReveal } from '../../../../src/components/geo/geoClueService.js';
import { validateGuess } from '../../../../src/components/geo/geoLocationService.js';

const PERSONA = 'You are Captain Crumb, a pirate who speaks in nautical metaphors.';

const lastRequest = () => generateStructuredJson.mock.calls.at(-1)[0];

beforeEach(() => {
    jest.clearAllMocks();
    getCachedPersona.mockImplementation((channel) =>
        String(channel).replace(/^#/, '') === 'piratechannel' ? PERSONA : null);
});

describe('game content generators', () => {
    test('trivia questions are generated in the channel persona', async () => {
        generateStructuredJson.mockResolvedValue({
            parsed: { question: 'Which ocean is the largest?', correct_answer: 'Pacific', alternate_answers: [] },
            searchUsed: false,
        });

        await generateQuestion('general', 'easy', [], 'piratechannel');

        const { systemInstruction } = lastRequest();
        expect(systemInstruction.startsWith(GAME_CORE_INSTRUCTION)).toBe(true);
        expect(systemInstruction).toContain(PERSONA);
        expect(getCachedPersona).toHaveBeenCalledWith('piratechannel');
    });

    test('riddles are generated in the channel persona, even with a # channel name', async () => {
        generateStructuredJson.mockResolvedValue({
            parsed: { riddle_question: 'I have a face but no eyes.', riddle_answer: 'Clock', keywords: ['time'] },
            searchUsed: false,
        });

        await generateRiddle('general', 'easy', [], '#piratechannel');

        const { systemInstruction } = lastRequest();
        expect(systemInstruction.startsWith(GAME_CORE_INSTRUCTION)).toBe(true);
        expect(systemInstruction).toContain(PERSONA);
    });

    test.each([
        ['initial clue', () => generateInitialClue('Lisbon', 'normal', 'real', null, null, 'piratechannel')],
        ['follow-up clue', () => generateFollowUpClue('Lisbon', ['A hilly coastal capital.'], 'real', null, 2, [], null, 'piratechannel')],
        ['final reveal', () => generateFinalReveal('Lisbon', 'real', null, 'timeout', null, 'piratechannel')],
    ])('geo %s is generated in the channel persona', async (_label, run) => {
        generateStructuredJson.mockResolvedValue({ clue_text: 'Arr.', reveal_text: 'Arr.' });

        await run();

        const { systemInstruction } = lastRequest();
        expect(systemInstruction.startsWith(GAME_CORE_INSTRUCTION)).toBe(true);
        expect(systemInstruction).toContain(PERSONA);
    });

    test('channels without a custom persona get the default one', async () => {
        generateStructuredJson.mockResolvedValue({ clue_text: 'A clue.' });

        await generateInitialClue('Lisbon', 'normal', 'real', null, null, 'plainchannel');

        const { systemInstruction } = lastRequest();
        expect(systemInstruction).toContain(DEFAULT_BOT_PERSONA);
        expect(systemInstruction).not.toContain(PERSONA);
    });
});

describe('answer checking stays persona-free', () => {
    test.each([
        ['trivia verification', () => verifyAnswer('Pacific', 'pacific ocean', [], 'Which ocean is the largest?', 'general')],
        ['riddle verification', () => verifyRiddleAnswer('Clock', 'a clock', 'I have a face but no eyes.')],
        ['geo guess validation', () => validateGuess('Lisbon', 'lisboa')],
    ])('%s sends no system instruction', async (_label, run) => {
        generateStructuredJson.mockResolvedValue({ is_correct: true, confidence: 1, reasoning: '' });

        await run();

        expect(generateStructuredJson).toHaveBeenCalled();
        expect(lastRequest().systemInstruction).toBeUndefined();
    });
});
