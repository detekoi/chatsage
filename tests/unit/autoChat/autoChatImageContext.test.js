import { refreshImageContext, buildImageContextLine, _getRuntime } from '../../../src/components/autoChat/autoChatManager.js';

// Mock all dependencies
jest.mock('../../../src/lib/logger.js');
jest.mock('../../../src/lib/ircSender.js');
jest.mock('../../../src/components/context/contextManager.js');
jest.mock('../../../src/components/llm/geminiClient.js');
jest.mock('../../../src/components/context/autoChatStorage.js');
jest.mock('../../../src/components/llm/llmUtils.js', () => ({
    removeMarkdownAsterisks: jest.fn(t => t),
}));

// The two dependencies under test
jest.mock('../../../src/components/twitch/streamImageCapture.js');
jest.mock('../../../src/components/llm/geminiImageClient.js');

import { fetchStreamThumbnail } from '../../../src/components/twitch/streamImageCapture.js';
import { analyzeImage } from '../../../src/components/llm/geminiImageClient.js';

describe('AutoChat Image Context', () => {
    const CHANNEL = 'testchannel';

    beforeEach(() => {
        jest.clearAllMocks();
        // Clear runtime state for clean tests
        const runtime = _getRuntime();
        runtime.delete(CHANNEL);
    });

    describe('refreshImageContext', () => {
        test('should fetch thumbnail and analyze image on first call', async () => {
            const fakeBuffer = Buffer.from('fake-image');
            fetchStreamThumbnail.mockResolvedValue(fakeBuffer);
            analyzeImage.mockResolvedValue('A player fights a dragon in a dark castle.');

            await refreshImageContext(CHANNEL);

            expect(fetchStreamThumbnail).toHaveBeenCalledWith(CHANNEL);
            expect(analyzeImage).toHaveBeenCalledWith(fakeBuffer, expect.any(String));

            const state = _getRuntime().get(CHANNEL);
            expect(state.lastImageContext).toBe('A player fights a dragon in a dark castle.');
            expect(state.lastImageFetchAtMs).toBeGreaterThan(0);
        });

        test('should throttle subsequent calls within IMAGE_REFRESH_MS', async () => {
            const fakeBuffer = Buffer.from('fake-image');
            fetchStreamThumbnail.mockResolvedValue(fakeBuffer);
            analyzeImage.mockResolvedValue('Scene description');

            // First call succeeds
            await refreshImageContext(CHANNEL);
            expect(fetchStreamThumbnail).toHaveBeenCalledTimes(1);

            // Second call should be throttled
            await refreshImageContext(CHANNEL);
            expect(fetchStreamThumbnail).toHaveBeenCalledTimes(1); // Still 1
        });

        test('should preserve previous context when thumbnail fetch fails', async () => {
            // Pre-populate some context
            const runtime = _getRuntime();
            runtime.set(CHANNEL, { lastImageContext: 'Previous scene', lastImageFetchAtMs: 0 });

            fetchStreamThumbnail.mockResolvedValue(null);

            await refreshImageContext(CHANNEL);

            const state = runtime.get(CHANNEL);
            expect(state.lastImageContext).toBe('Previous scene'); // Unchanged
        });

        test('should preserve previous context when analyzeImage returns empty', async () => {
            const runtime = _getRuntime();
            runtime.set(CHANNEL, { lastImageContext: 'Old scene', lastImageFetchAtMs: 0 });

            fetchStreamThumbnail.mockResolvedValue(Buffer.from('image'));
            analyzeImage.mockResolvedValue('');

            await refreshImageContext(CHANNEL);

            const state = runtime.get(CHANNEL);
            expect(state.lastImageContext).toBe('Old scene'); // Unchanged
        });

        test('should preserve previous context and still update timestamp on error', async () => {
            const runtime = _getRuntime();
            runtime.set(CHANNEL, { lastImageContext: 'Stale scene', lastImageFetchAtMs: 0 });

            fetchStreamThumbnail.mockRejectedValue(new Error('Network error'));

            await refreshImageContext(CHANNEL);

            const state = runtime.get(CHANNEL);
            expect(state.lastImageContext).toBe('Stale scene'); // Unchanged
            expect(state.lastImageFetchAtMs).toBeGreaterThan(0); // Timestamp updated
        });
    });

    describe('buildImageContextLine', () => {
        test('should return context line when lastImageContext is set', () => {
            const runtime = _getRuntime();
            runtime.set(CHANNEL, { lastImageContext: 'Boss fight in a dungeon' });

            const result = buildImageContextLine(CHANNEL);
            expect(result).toBe(' Stream screenshot context: "Boss fight in a dungeon"');
        });

        test('should return empty string when lastImageContext is null', () => {
            const runtime = _getRuntime();
            runtime.set(CHANNEL, {});

            const result = buildImageContextLine(CHANNEL);
            expect(result).toBe('');
        });

        test('should return empty string for unknown channel', () => {
            const result = buildImageContextLine('nonexistent');
            expect(result).toBe('');
        });
    });
});
