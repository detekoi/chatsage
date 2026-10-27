// tests/unit/lib/slurFilter.test.js

import { maskSlurs, SLUR_PLACEHOLDER } from '../../../src/lib/slurFilter.js';

describe('slurFilter', () => {
    describe('maskSlurs', () => {
        it('should replace a slur with the placeholder', () => {
            expect(maskSlurs('faggot')).toEqual({ text: SLUR_PLACEHOLDER, replaced: 1 });
        });

        it('should match regardless of case', () => {
            expect(maskSlurs('FAGGOTS lol').text).toBe('[slur] lol');
        });

        it('should replace every slur in the text', () => {
            const result = maskSlurs('jotillo y maricón');
            expect(result).toEqual({ text: '[slur] y [slur]', replaced: 2 });
        });

        it('should match slurs with accented letters at the word edge', () => {
            expect(maskSlurs('eres un maricón.').text).toBe('eres un [slur].');
        });

        it('should keep ordinary profanity', () => {
            const text = 'what the fuck, this shit is bullshit, puto';
            expect(maskSlurs(text)).toEqual({ text, replaced: 0 });
        });

        it('should match compound forms with any ending', () => {
            expect(maskSlurs('sandnigga sandniggers').text).toBe('[slur] [slur]');
        });

        it('should keep words that only look like slurs in other languages', () => {
            const text = 'Hola Kike, @kike toca el fagot en el concierto para fagots';
            expect(maskSlurs(text)).toEqual({ text, replaced: 0 });
        });

        it('should keep reclaimed words', () => {
            const text = 'dyke march, queer and proud, dykes on bikes';
            expect(maskSlurs(text)).toEqual({ text, replaced: 0 });
        });

        it('should not match a slur inside a longer word', () => {
            const text = 'the jotoque team, negro, en retard, Niger';
            expect(maskSlurs(text)).toEqual({ text, replaced: 0 });
        });

        it('should pass non-string and empty input through', () => {
            expect(maskSlurs('')).toEqual({ text: '', replaced: 0 });
            expect(maskSlurs(null)).toEqual({ text: null, replaced: 0 });
        });
    });
});
