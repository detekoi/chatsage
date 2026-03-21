// tests/unit/lib/geminiEmoteDescriber.test.js

jest.mock('../../../src/lib/logger.js');
jest.mock('@google/genai');
jest.mock('sharp');
jest.mock('../../../src/config/index.js', () => ({
    __esModule: true,
    default: {
        emote: {
            geminiModel: 'gemini-3.1-flash-lite-preview',
            cdnUrl: 'https://static-cdn.jtvnw.net/emoticons/v2',
            timeoutMs: 8000,
            animatedTimeoutMs: 12000,
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
    getAnimatedEmoteUrl,
    getEmoteContextString,
    _descriptionCache,
} from '../../../src/lib/geminiEmoteDescriber.js';
import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';

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

// Setup mock sharp — returns chainable metadata/png/toBuffer
const mockToBuffer = jest.fn();
const mockPng = jest.fn(() => ({ toBuffer: mockToBuffer }));
const mockMetadata = jest.fn();
sharp.mockReturnValue({
    metadata: mockMetadata,
    png: mockPng,
});

describe('geminiEmoteDescriber', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        _descriptionCache.clear();
        mockFetch.mockReset();
        mockGenerateContent.mockReset();
        mockGet.mockReset();
        mockSet.mockReset().mockResolvedValue(undefined);
        mockToBuffer.mockReset();
        mockPng.mockReset().mockReturnValue({ toBuffer: mockToBuffer });
        mockMetadata.mockReset();
        sharp.mockReturnValue({
            metadata: mockMetadata,
            png: mockPng,
        });
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

        it('should extract a single static emote', () => {
            const fragments = [
                { type: 'emote', text: 'Kappa', emote: { id: '25', format: ['static'] } },
            ];
            const result = extractEmotesFromFragments(fragments);
            expect(result).toEqual([{ id: '25', name: 'Kappa', count: 1, isAnimated: false }]);
        });

        it('should detect animated emotes from format array', () => {
            const fragments = [
                { type: 'emote', text: 'catJAM', emote: { id: '123', format: ['animated', 'static'] } },
            ];
            const result = extractEmotesFromFragments(fragments);
            expect(result).toEqual([{ id: '123', name: 'catJAM', count: 1, isAnimated: true }]);
        });

        it('should count repeated emotes', () => {
            const fragments = [
                { type: 'emote', text: 'Kappa', emote: { id: '25', format: ['static'] } },
                { type: 'text', text: ' ' },
                { type: 'emote', text: 'Kappa', emote: { id: '25', format: ['static'] } },
            ];
            const result = extractEmotesFromFragments(fragments);
            expect(result).toEqual([{ id: '25', name: 'Kappa', count: 2, isAnimated: false }]);
        });

        it('should extract mixed static and animated emotes', () => {
            const fragments = [
                { type: 'emote', text: 'Kappa', emote: { id: '25', format: ['static'] } },
                { type: 'text', text: ' ' },
                { type: 'emote', text: 'catJAM', emote: { id: '123', format: ['animated', 'static'] } },
            ];
            const result = extractEmotesFromFragments(fragments);
            expect(result).toHaveLength(2);
            expect(result.find(e => e.id === '25')).toMatchObject({ isAnimated: false });
            expect(result.find(e => e.id === '123')).toMatchObject({ isAnimated: true });
        });

        it('should ignore non-emote fragments', () => {
            const fragments = [
                { type: 'text', text: 'Hello there!' },
                { type: 'emote', text: 'Kappa', emote: { id: '25' } },
                { type: 'mention', text: '@someone' },
            ];
            const result = extractEmotesFromFragments(fragments);
            expect(result).toEqual([{ id: '25', name: 'Kappa', count: 1, isAnimated: false }]);
        });
    });

    describe('getEmoteImageUrl', () => {
        it('should build the correct static CDN URL', () => {
            const url = getEmoteImageUrl('25');
            expect(url).toBe('https://static-cdn.jtvnw.net/emoticons/v2/25/static/dark/3.0');
        });
    });

    describe('getAnimatedEmoteUrl', () => {
        it('should build the correct animated CDN URL', () => {
            const url = getAnimatedEmoteUrl('123');
            expect(url).toBe('https://static-cdn.jtvnw.net/emoticons/v2/123/animated/dark/3.0');
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

        it('should describe a static emote', async () => {
            mockGet.mockResolvedValue({ exists: false });
            mockFetch.mockResolvedValueOnce({
                ok: true,
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
                headers: { get: () => 'image/png' },
            });
            mockGenerateContent.mockResolvedValueOnce({
                text: '{"description": "smirking grey face, sarcasm"}',
            });

            const tags = {
                fragments: [
                    { type: 'emote', text: 'Kappa', emote: { id: '25', format: ['static'] } },
                ],
            };
            const result = await getEmoteContextString(tags, 'Kappa');
            expect(result).toBe('[Emotes in message: Kappa = smirking grey face, sarcasm]');
        });

        it('should describe an animated emote using frame strip', async () => {
            mockGet.mockResolvedValue({ exists: false });

            // animated GIF fetch
            mockFetch.mockResolvedValueOnce({
                ok: true,
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(16)),
                headers: { get: () => 'image/gif' },
            });

            // sharp GIF extraction
            mockMetadata.mockResolvedValueOnce({ pages: 12 });
            mockToBuffer.mockResolvedValueOnce(Buffer.from('strip-png-data'));

            mockGenerateContent.mockResolvedValueOnce({
                text: '{"description": "cat nodding to music, vibing"}',
            });

            const tags = {
                fragments: [
                    { type: 'emote', text: 'catJAM', emote: { id: '123', format: ['animated', 'static'] } },
                ],
            };
            const result = await getEmoteContextString(tags, 'catJAM');
            expect(result).toBe('[Emotes in message: catJAM = cat nodding to music, vibing]');

            // Verify animated prompt was used (contains "animation strip")
            const callArgs = mockGenerateContent.mock.calls[0][0];
            expect(callArgs.contents.at(-1).text).toContain('animation strip');
        });

        it('should fall back to static when animated fetch fails', async () => {
            mockGet.mockResolvedValue({ exists: false });

            // animated GIF fetch fails
            mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

            // static PNG fetch succeeds
            mockFetch.mockResolvedValueOnce({
                ok: true,
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
                headers: { get: () => 'image/png' },
            });

            mockGenerateContent.mockResolvedValueOnce({
                text: '{"description": "cat nodding"}',
            });

            const tags = {
                fragments: [
                    { type: 'emote', text: 'catJAM', emote: { id: '123', format: ['animated', 'static'] } },
                ],
            };
            const result = await getEmoteContextString(tags, 'catJAM');
            expect(result).toBe('[Emotes in message: catJAM = cat nodding]');

            // Verify static prompt was used (no "animation strip")
            const callArgs = mockGenerateContent.mock.calls[0][0];
            expect(callArgs.contents.at(-1).text).not.toContain('animation strip');
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

            await getEmoteContextString(tags, 'Kappa');
            expect(mockGenerateContent).toHaveBeenCalledTimes(1);

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

        it('should verify system instruction mentions chat AI understanding', async () => {
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
            await getEmoteContextString(tags, 'Kappa');

            const callArgs = mockGenerateContent.mock.calls[0][0];
            expect(callArgs.systemInstruction).toContain('chat AI can understand');
            expect(callArgs.systemInstruction).toContain('emotional meaning');
        });
    });
});
