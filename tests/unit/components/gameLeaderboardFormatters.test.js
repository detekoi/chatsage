// tests/unit/components/gameLeaderboardFormatters.test.js

jest.mock('../../../src/lib/logger.js');
jest.mock('../../../src/components/llm/llmUtils.js', () => ({ removeMarkdownAsterisks: text => text }));

import { formatLeaderboardMessage as triviaLeaderboard } from '../../../src/components/trivia/triviaMessageFormatter.js';
import { formatLeaderboardMessage as geoLeaderboard } from '../../../src/components/geo/geoMessageFormatter.js';
import { formatRiddleLeaderboardMessage as riddleLeaderboard } from '../../../src/components/riddle/riddleMessageFormatter.js';

const data = [
    { id: 'low', data: { displayName: 'Low', channelPoints: 10, channelSuccesses: 1 } },
    { id: 'high', data: { displayName: 'High', channelPoints: 90, channelSuccesses: 7 } },
    { id: 'nameless', data: { channelPoints: 50, channelSuccesses: 3 } },
];

describe.each([
    ['trivia', triviaLeaderboard, 'Trivia', '🏆 Trivia Champions in #chan: 1. High (90 pts, 7 correct), 2. nameless (50 pts, 3 correct), 3. Low (10 pts, 1 correct)'],
    ['geo', geoLeaderboard, 'Geo-Game', '🏆 Geo-Game Top Players in #chan: 1. High (90 pts, 7 wins), 2. nameless (50 pts, 3 wins), 3. Low (10 pts, 1 wins)'],
])('%s leaderboard formatter', (_name, format, label, expected) => {
    it('ranks by points in English when no language is given', () => {
        expect(format(data, 'chan')).toBe(expected);
    });

    it('does not reorder the caller\'s array', () => {
        const input = [...data];
        format(input, 'chan');
        expect(input.map(p => p.id)).toEqual(['low', 'high', 'nameless']);
    });

    it('limits the list to five players', () => {
        const many = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, data: { channelPoints: i } }));
        expect(format(many, 'chan').match(/ pts,/g)).toHaveLength(5);
    });

    it('explains an empty leaderboard', () => {
        expect(format([], 'chan')).toBe(`No ${label} stats found for this channel (chan) yet!`);
        expect(format(null, 'chan')).toBe(`No ${label} stats found for this channel (chan) yet!`);
    });

    it('answers from the catalog in a catalogued language', () => {
        const out = format(data, 'chan', 'spanish');
        expect(out).toContain('#chan');
        expect(out).toContain('High (90 pts,');
        expect(out).not.toContain(label === 'Trivia' ? 'Champions' : 'Top Players');
        expect(format([], 'chan', 'spanish')).not.toMatch(/stats found/);
    });

    it('falls back to English in an uncatalogued language', () => {
        expect(format(data, 'chan', 'klingon')).toBe(expected);
    });
});

// Stats docs are keyed by Twitch user ID, so a row's id is numeric; the stored login must be shown instead.
describe.each([
    ['trivia', triviaLeaderboard],
    ['geo', geoLeaderboard],
    ['riddle', riddleLeaderboard],
])('%s leaderboard name fallback', (_name, format) => {
    it('shows the login rather than the numeric user ID when no display name is stored', () => {
        const out = format([{ id: '12345', data: { login: 'alice', channelPoints: 5, channelSuccesses: 1 } }], 'chan');
        expect(out).toContain('alice');
        expect(out).not.toContain('12345');
    });
});
