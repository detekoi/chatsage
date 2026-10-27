// Last-line guard for text the bot posts: the translation prompt asks the model to
// replace slurs, but nothing makes it comply, and Twitch AutoMod holds bot messages
// that contain them. Ordinary profanity is left alone on purpose.
//
// Only terms with no common innocent meaning in the languages the bot writes are
// listed, so not "negro" (a color), "retard"/"retards" (French for "delay"),
// "fag" (UK cigarette), "fagot" (bassoon in Spanish, Polish and others), "kike"
// (Spanish nickname for Enrique), "puto" (general Spanish swearing) or "finocchio" (fennel).
// Reclaimed words ("dyke", "queer") are left alone too.

export const SLUR_PLACEHOLDER = '[slur]';

const SLUR_STEMS = [
    // Racial and ethnic
    '(?:sand)?nigg(?:er|ers|a|as|ah|az|uh)',
    'negratas?',
    'spics?',
    'wetbacks?',
    'beaners?',
    'gooks?',
    'pakis?',
    // Homophobic and transphobic
    'faggots?',
    'faggy',
    'tranny',
    'trannies',
    'shemales?',
    'maric[oó]n(?:es|cito|citos)?',
    'jot(?:o|os|illo|illos|ito|itos)',
    'viad(?:o|os|inho|inhos)',
    'schwuchtel(?:n)?',
    'pédés?',
    'froci(?:o)?',
    // Ableist
    'retarded'
];

// \b only knows ASCII letters, so accented letters ("maricón") need Unicode-aware edges
const SLUR_PATTERN = new RegExp(`(?<![\\p{L}\\p{N}])(?:${SLUR_STEMS.join('|')})(?![\\p{L}\\p{N}])`, 'giu');

/**
 * Replaces listed slurs in text with SLUR_PLACEHOLDER.
 * @param {string} text
 * @returns {{text: string, replaced: number}} The masked text and how many slurs were replaced
 */
export function maskSlurs(text) {
    if (typeof text !== 'string' || !text) {
        return { text, replaced: 0 };
    }
    let replaced = 0;
    const masked = text.replace(SLUR_PATTERN, () => {
        replaced++;
        return SLUR_PLACEHOLDER;
    });
    return { text: masked, replaced };
}
