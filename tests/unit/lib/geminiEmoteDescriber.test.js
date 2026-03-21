// tests/unit/lib/geminiEmoteDescriber.test.js

jest.mock('../../../src/lib/logger.js');
jest.mock('@google/genai');
jest.mock('../../../src/config/index.js', () => ({
    __esModule: true,
    default: {
        emote: {
            geminiModel: 'gemini-3.1-flash-lite-preview',
            cdnUrl: 'https://static-cdn.jtvnw.net/emoticons/v2',
            timeoutMs: 8000,
        },
        gemini: { apiKey: 'test-key' },
    },
}));

// Setup mock Firestore (via centralized helper)
const mockGet = jest.fn();
const mockSet = jest.fn().mockResolvedValue(undefined);
const mockDoc = jest.fn(() => ({ get: mockGet, set: mockSet }));
const mockCollection = jest.fn(() => ({ doc: mockDoc }));
const mockFirestoreInstance = { collection: mockCollection };

jest.mock('../../../src/lib/firestore.js', () => ({
    getFirestore: jest.fn(() => mockFirestoreInstance),
    FieldValue: { serverTimestamp: jest.fn(() => 'mock-timestamp') },
}));

import {
    initEmoteDescriber,
    initEmoteDescriptionStore,
    isEmoteDescriberAvailable,
    extractEmotesFromFragments,
    getEmoteImageUrl,
    getEmoteContextString,
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
        mockGet.mockReset();
        mockSet.mockReset().mockResolvedValue(undefined);
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

    describe('initEmoteDescriptionStore', () => {
        it('should initialize from shared Firestore and return true', () => {
            const { getFirestore } = require('../../../src/lib/firestore.js');
            expect(initEmoteDescriptionStore()).toBe(true);
            expect(getFirestore).toHaveBeenCalled();
        });
    });

    describe('extractEmotesFromFragments', () => {
        it('should return empty array for null/undefined/empty fragments', () => {
            expect(extractEmotesFromFragments(null)).toEqual([]);
            expect(extractEmotesFromFragments(undefined)).toEqual([]);
            expect(extractEmotesFromFragments([])).toEqual([]);
        });

        it('should extract a single emote', () => {
            const fragments = [
                { type: 'emote', text: 'Kappa', emote: { id: '25' } },
            ];
            const result = extractEmotesFromFragments(fragments);
            expect(result).toEqual([{ id: '25', name: 'Kappa', count: 1 }]);
        });

        it('should count repeated emotes', () => {
            const fragments = [
                { type: 'emote', text: 'Kappa', emote: { id: '25' } },
                { type: 'text', text: ' ' },
                { type: 'emote', text: 'Kappa', emote: { id: '25' } },
            ];
            const result = extractEmotesFromFragments(fragments);
            expect(result).toEqual([{ id: '25', name: 'Kappa', count: 2 }]);
        });

        it('should extract multiple different emotes', () => {
            const fragments = [
                { type: 'emote', text: 'Kappa', emote: { id: '25' } },
                { type: 'text', text: ' ' },
                { type: 'emote', text: 'LUL', emote: { id: '425618' } },
            ];
            const result = extractEmotesFromFragments(fragments);
            expect(result).toHaveLength(2);
            expect(result.find(e => e.id === '25')).toEqual({ id: '25', name: 'Kappa', count: 1 });
            expect(result.find(e => e.id === '425618')).toEqual({ id: '425618', name: 'LUL', count: 1 });
        });

        it('should ignore non-emote fragments', () => {
            const fragments = [
                { type: 'text', text: 'Hello there!' },
                { type: 'emote', text: 'Kappa', emote: { id: '25' } },
                { type: 'mention', text: '@someone' },
            ];
            const result = extractEmotesFromFragments(fragments);
            expect(result).toEqual([{ id: '25', name: 'Kappa', count: 1 }]);
        });

        it('should skip emote fragments without an id', () => {
            const fragments = [
                { type: 'emote', text: 'Kappa', emote: {} },
                { type: 'emote', text: 'LUL', emote: { id: '425618' } },
            ];
            const result = extractEmotesFromFragments(fragments);
            expect(result).toEqual([{ id: '425618', name: 'LUL', count: 1 }]);
        });
    });

    describe('getEmoteImageUrl', () => {
        it('should build the correct CDN URL', () => {
            const url = getEmoteImageUrl('25');
            expect(url).toBe('https://static-cdn.jtvnw.net/emoticons/v2/25/static/dark/3.0');
        });
    });

    describe('getEmoteContextString', () => {
        beforeEach(() => {
            initEmoteDescriber('test-api-key');
        });

        it('should return null when no fragments', async () => {
            const result = await getEmoteContextString({}, 'Hello!');
            expect(result).toBeNull();
        });

        it('should return null when fragments have no emotes', async () => {
            const tags = { fragments: [{ type: 'text', text: 'Hello!' }] };
            const result = await getEmoteContextString(tags, 'Hello!');
            expect(result).toBeNull();
        });

        it('should return context string with described emotes via structured JSON', async () => {
            mockGet.mockResolvedValue({ exists: false });

            mockFetch.mockResolvedValueOnce({
                ok: true,
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
                headers: { get: () => 'image/png' },
            });

            mockGenerateContent.mockResolvedValueOnce({
                text: '{"description": "smirking face"}',
            });

            const tags = {
                fragments: [
                    { type: 'emote', text: 'Kappa', emote: { id: '25' } },
                ],
            };
            const result = await getEmoteContextString(tags, 'Kappa');
            expect(result).toBe('[Emotes in message: Kappa = smirking face]');

            // Verify system instruction and structured output were passed
            expect(mockGenerateContent).toHaveBeenCalledWith(
                expect.objectContaining({
                    systemInstruction: expect.stringContaining('accessibility assistant'),
                    config: expect.objectContaining({
                        responseMimeType: 'application/json',
                        responseJsonSchema: expect.objectContaining({
                            type: 'object',
                            properties: expect.objectContaining({
                                description: expect.any(Object),
                            }),
                        }),
                    }),
                })
            );
        });

        it('should use L1 cached description on second call', async () => {
            mockGet.mockResolvedValue({ exists: false });

            mockFetch.mockResolvedValueOnce({
                ok: true,
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
                headers: { get: () => 'image/png' },
            });

            mockGenerateContent.mockResolvedValueOnce({
                text: '{"description": "smirking face"}',
            });

            const tags = {
                fragments: [
                    { type: 'emote', text: 'Kappa', emote: { id: '25' } },
                ],
            };

            // First call — hits Gemini
            await getEmoteContextString(tags, 'Kappa');
            expect(mockGenerateContent).toHaveBeenCalledTimes(1);

            // Second call — L1 cache
            const result = await getEmoteContextString(tags, 'Kappa');
            expect(result).toBe('[Emotes in message: Kappa = smirking face]');
            expect(mockGenerateContent).toHaveBeenCalledTimes(1);
        });

        it('should load description from Firestore L2 cache', async () => {
            initEmoteDescriptionStore();

            mockGet.mockResolvedValue({
                exists: true,
                data: () => ({ description: 'laughing face', emoteName: 'LUL' }),
            });

            const tags = {
                fragments: [
                    { type: 'emote', text: 'LUL', emote: { id: '425618' } },
                ],
            };
            const result = await getEmoteContextString(tags, 'LUL');
            expect(result).toBe('[Emotes in message: LUL = laughing face]');
            expect(mockGenerateContent).not.toHaveBeenCalled();
        });

        it('should return null when image fetch fails', async () => {
            mockGet.mockResolvedValue({ exists: false });

            mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

            const tags = {
                fragments: [
                    { type: 'emote', text: 'Kappa', emote: { id: '25' } },
                ],
            };
            const result = await getEmoteContextString(tags, 'Kappa');
            expect(result).toBeNull();
        });

        it('should return null when Gemini fails', async () => {
            mockGet.mockResolvedValue({ exists: false });

            mockFetch.mockResolvedValueOnce({
                ok: true,
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
                headers: { get: () => 'image/png' },
            });

            mockGenerateContent.mockRejectedValueOnce(new Error('API Error'));

            const tags = {
                fragments: [
                    { type: 'emote', text: 'Kappa', emote: { id: '25' } },
                ],
            };
            const result = await getEmoteContextString(tags, 'Kappa');
            expect(result).toBeNull();
        });

        it('should describe multiple different emotes', async () => {
            mockGet.mockResolvedValue({ exists: false });

            mockFetch
                .mockResolvedValueOnce({
                    ok: true,
                    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
                    headers: { get: () => 'image/png' },
                })
                .mockResolvedValueOnce({
                    ok: true,
                    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
                    headers: { get: () => 'image/png' },
                });

            mockGenerateContent
                .mockResolvedValueOnce({ text: '{"description": "smirking face"}' })
                .mockResolvedValueOnce({ text: '{"description": "laughing man"}' });

            const tags = {
                fragments: [
                    { type: 'emote', text: 'Kappa', emote: { id: '25' } },
                    { type: 'text', text: ' hello ' },
                    { type: 'emote', text: 'LUL', emote: { id: '425618' } },
                ],
            };
            const result = await getEmoteContextString(tags, 'Kappa hello LUL');
            expect(result).toBe('[Emotes in message: Kappa = smirking face, LUL = laughing man]');
        });
    });
});
