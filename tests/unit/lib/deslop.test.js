// tests/unit/lib/deslop.test.js

jest.mock('../../../src/components/context/responseStyleStorage.js', () => ({
    isDeslopEnabled: jest.fn(() => false),
}));

import { scrubSlop, applyDeslop, summaryStyleOptions, DESLOP_SUMMARY_HINT } from '../../../src/lib/deslop.js';
import { isDeslopEnabled } from '../../../src/components/context/responseStyleStorage.js';

describe('scrubSlop', () => {
    test.each([
        ['spaced em dash', 'The boss is hard — really hard.', 'The boss is hard, really hard.'],
        ['unspaced em dash', 'The boss is hard—really hard.', 'The boss is hard, really hard.'],
        ['paired em dashes', 'The patch — out today — fixes it.', 'The patch, out today, fixes it.'],
        ['spaced en dash', 'Good run – nice one.', 'Good run, nice one.'],
        ['spaced double hyphen', 'Good run -- nice one.', 'Good run, nice one.'],
        ['number range', 'It takes 10–12 hours, or 3 – 4 on easy.', 'It takes 10-12 hours, or 3-4 on easy.'],
        ['dash after other punctuation', 'Wait! — not that door.', 'Wait! not that door.'],
        ['leading dash', '— nice one', 'nice one'],
        ['trailing dash', 'and then—', 'and then'],
        ['curly double quotes', 'They call it “the wall”.', 'They call it "the wall".'],
        ['curly apostrophe', 'It’s fine.', 'It\'s fine.'],
        ['chatbot opener', 'Great question! the answer is 42.', 'The answer is 42.'],
        ['chatbot opener with a comma', 'Certainly, it came out in 1998.', 'It came out in 1998.'],
    ])('fixes a %s', (_label, input, expected) => {
        expect(scrubSlop(input)).toBe(expected);
    });

    test.each([
        ['plain text', 'Nice clutch, that was close.'],
        ['hyphenated words', 'A well-known speed-run trick.'],
        ['a URL with hyphens', 'See https://example.com/some-page--draft for more.'],
        ['a negative number', 'It drops to -5 at night.'],
        ['an opener word used as a normal word', 'Certainly not the best map.'],
        ['a reply that is only the opener', 'Of course!'],
        ['emoji and emotes', 'PogChamp that was clean 🔥'],
    ])('leaves %s alone', (_label, input) => {
        expect(scrubSlop(input)).toBe(input);
    });

    test('passes through values that are not text', () => {
        expect(scrubSlop('')).toBe('');
        expect(scrubSlop(null)).toBeNull();
        expect(scrubSlop(undefined)).toBeUndefined();
    });
});

describe('applyDeslop', () => {
    const text = 'Good run — nice one.';

    test('returns the text unchanged when the channel has the switch off', () => {
        isDeslopEnabled.mockReturnValue(false);
        expect(applyDeslop('#somechannel', text)).toBe(text);
    });

    test('cleans the text when the channel has the switch on', () => {
        isDeslopEnabled.mockReturnValue(true);
        expect(applyDeslop('#somechannel', text)).toBe('Good run, nice one.');
        expect(isDeslopEnabled).toHaveBeenCalledWith('#somechannel');
    });
});

describe('summaryStyleOptions', () => {
    test('is empty when the channel has the switch off', () => {
        isDeslopEnabled.mockReturnValue(false);
        expect(summaryStyleOptions('somechannel')).toEqual({});
    });

    test('carries the summary hint when the channel has the switch on', () => {
        isDeslopEnabled.mockReturnValue(true);
        expect(summaryStyleOptions('somechannel')).toEqual({ styleHint: DESLOP_SUMMARY_HINT });
    });
});
