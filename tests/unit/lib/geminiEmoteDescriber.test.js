// tests/unit/lib/geminiEmoteDescriber.test.js

jest.mock('../../../src/lib/logger.js');
jest.mock('@google/genai');

import {
    initEmoteDescriber,
    isEmoteDescriberAvailable,
    parseEmotesFromIRC,
    getEmoteImageUrl,
    enrichMessageWithEmoteDescriptions,
    _descriptionCache,
} from '../../../src/lib/geminiEmoteDescriber.js';
import { GoogleGenAI } from '@google/genai';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Setup mock Gemini client
const mockGenerateContent = jest.fn();
GoogleGenAI.mockImplementation(() => ({
    models: {
        generateContent: mockGenerateContent,
    },
}));

describe('geminiEmoteDescriber', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        _descriptionCache.clear();
        mockFetch.mockReset();
        mockGenerateContent.mockReset();
    });

    describe('initEmoteDescriber', () => {
        it('should return false when no API key is provided', () => {
            expect(initEmoteDescriber(null)).toBe(false);
            expect(initEmoteDescriber('')).toBe(false);
        });

        it('should return true when API key is provided', () => {
            expect(initEmoteDescriber('test-api-key')).toBe(true);
        });

        it('should mark describer as available after init', () => {
            initEmoteDescriber('test-api-key');
            expect(isEmoteDescriberAvailable()).toBe(true);
        });
    });

    describe('parseEmotesFromIRC', () => {
        it('should return empty array for null/undefined emotes', () => {
            expect(parseEmotesFromIRC(null, 'hello')).toEqual([]);
            expect(parseEmotesFromIRC(undefined, 'hello')).toEqual([]);
        });

        it('should return empty array for empty emotes object', () => {
            expect(parseEmotesFromIRC({}, 'hello')).toEqual([]);
        });

        it('should parse a single emote', () => {
            const emotesTag = { '25': ['0-4'] };
            const message = 'Kappa';
            const result = parseEmotesFromIRC(emotesTag, message);
            expect(result).toEqual([{ id: '25', name: 'Kappa', count: 1 }]);
        });

        it('should parse multiple occurrences of the same emote', () => {
            const emotesTag = { '25': ['0-4', '6-10'] };
            const message = 'Kappa Kappa';
            const result = parseEmotesFromIRC(emotesTag, message);
            expect(result).toEqual([{ id: '25', name: 'Kappa', count: 2 }]);
        });

        it('should parse multiple different emotes', () => {
            const emotesTag = { '25': ['0-4'], '1902': ['6-10'] };
            const message = 'Kappa Keepo';
            const result = parseEmotesFromIRC(emotesTag, message);
            expect(result).toHaveLength(2);
            expect(result.find(e => e.id === '25')).toEqual({ id: '25', name: 'Kappa', count: 1 });
            expect(result.find(e => e.id === '1902')).toEqual({ id: '1902', name: 'Keepo', count: 1 });
        });

        it('should parse emotes mixed with text', () => {
            const emotesTag = { '25': ['10-14'] };
            const message = 'Nice play Kappa';
            const result = parseEmotesFromIRC(emotesTag, message);
            expect(result).toEqual([{ id: '25', name: 'Kappa', count: 1 }]);
        });

        it('should handle invalid position strings gracefully', () => {
            const emotesTag = { '25': ['invalid'] };
            const message = 'Kappa';
            const result = parseEmotesFromIRC(emotesTag, message);
            expect(result).toEqual([]);
        });

        it('should handle out-of-bounds positions gracefully', () => {
            const emotesTag = { '25': ['100-200'] };
            const message = 'Kappa';
            const result = parseEmotesFromIRC(emotesTag, message);
            expect(result).toEqual([]);
        });
    });

    describe('getEmoteImageUrl', () => {
        it('should build the correct CDN URL', () => {
            const url = getEmoteImageUrl('25');
            expect(url).toBe('https://static-cdn.jtvnw.net/emoticons/v2/25/static/dark/3.0');
        });
    });

    describe('enrichMessageWithEmoteDescriptions', () => {
        beforeEach(() => {
            initEmoteDescriber('test-api-key');
        });

        it('should return original message when no emotes', async () => {
            const tags = {};
            const message = 'Hello everyone!';
            const result = await enrichMessageWithEmoteDescriptions(tags, message);
            expect(result).toBe('Hello everyone!');
        });

        it('should return original message when emotes is null', async () => {
            const tags = { emotes: null };
            const message = 'Hello everyone!';
            const result = await enrichMessageWithEmoteDescriptions(tags, message);
            expect(result).toBe('Hello everyone!');
        });

        it('should enrich a message with emote description', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
                headers: { get: () => 'image/png' },
            });

            mockGenerateContent.mockResolvedValueOnce({
                text: 'smirking face',
            });

            const tags = { emotes: { '25': ['0-4'] } };
            const message = 'Kappa';
            const result = await enrichMessageWithEmoteDescriptions(tags, message);
            expect(result).toBe('Kappa (smirking face)');
        });

        it('should enrich message with emotes mixed in text', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
                headers: { get: () => 'image/png' },
            });

            mockGenerateContent.mockResolvedValueOnce({
                text: 'smirking face',
            });

            const tags = { emotes: { '25': ['11-15'] } };
            const message = 'Nice play! Kappa';
            const result = await enrichMessageWithEmoteDescriptions(tags, message);
            expect(result).toBe('Nice play! Kappa (smirking face)');
        });

        it('should handle multiple occurrences of same emote', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
                headers: { get: () => 'image/png' },
            });

            mockGenerateContent.mockResolvedValueOnce({
                text: 'smirking face',
            });

            const tags = { emotes: { '25': ['0-4', '6-10'] } };
            const message = 'Kappa Kappa';
            const result = await enrichMessageWithEmoteDescriptions(tags, message);
            expect(result).toBe('Kappa (smirking face) Kappa (smirking face)');
        });

        it('should use cached description on second call', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
                headers: { get: () => 'image/png' },
            });

            mockGenerateContent.mockResolvedValueOnce({
                text: 'smirking face',
            });

            const tags = { emotes: { '25': ['0-4'] } };
            const message = 'Kappa';

            // First call — should hit Gemini
            await enrichMessageWithEmoteDescriptions(tags, message);
            expect(mockGenerateContent).toHaveBeenCalledTimes(1);

            // Second call — should use cache
            const result = await enrichMessageWithEmoteDescriptions(tags, message);
            expect(result).toBe('Kappa (smirking face)');
            expect(mockGenerateContent).toHaveBeenCalledTimes(1); // Not called again
        });

        it('should return original message when image fetch fails', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404,
            });

            const tags = { emotes: { '25': ['0-4'] } };
            const message = 'Kappa';
            const result = await enrichMessageWithEmoteDescriptions(tags, message);
            expect(result).toBe('Kappa');
        });

        it('should return original message when Gemini fails', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
                headers: { get: () => 'image/png' },
            });

            mockGenerateContent.mockRejectedValueOnce(new Error('API Error'));

            const tags = { emotes: { '25': ['0-4'] } };
            const message = 'Kappa';
            const result = await enrichMessageWithEmoteDescriptions(tags, message);
            expect(result).toBe('Kappa');
        });
    });
});
