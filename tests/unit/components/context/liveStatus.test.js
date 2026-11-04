// tests/unit/components/context/liveStatus.test.js
import { getContextManager } from '../../../../src/components/context/contextManager.js';
import { isStreamLive, getStreamGame } from '../../../../src/components/context/liveStatus.js';

jest.mock('../../../../src/components/context/contextManager.js');

function mockStreamGame(streamGame) {
    getContextManager.mockReturnValue({
        getContextForLLM: jest.fn().mockReturnValue({ streamGame }),
    });
}

describe('liveStatus', () => {
    beforeEach(() => jest.clearAllMocks());

    test('getStreamGame returns the game the channel streams', () => {
        mockStreamGame('Hollow Knight');
        expect(getStreamGame('chan')).toBe('Hollow Knight');
        expect(isStreamLive('chan')).toBe(true);
    });

    test('getStreamGame returns null for the N/A placeholder', () => {
        mockStreamGame('N/A');
        expect(getStreamGame('chan')).toBeNull();
        expect(isStreamLive('chan')).toBe(false);
    });

    test('getStreamGame returns null when the context lookup throws', () => {
        getContextManager.mockReturnValue({
            getContextForLLM: jest.fn(() => { throw new Error('no state'); }),
        });
        expect(getStreamGame('chan')).toBeNull();
    });
});
