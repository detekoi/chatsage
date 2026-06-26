import { pronounService } from '../../../src/lib/pronounService.js';

// Mock the global fetch
const originalFetch = global.fetch;

describe('pronounService', () => {
    beforeEach(() => {
        pronounService.userPronounsCache.cache.clear();
        pronounService.pendingRequests.clear();
        
        global.fetch = jest.fn();
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });


    test('getUserPronouns returns full grammar', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => [ { pronoun_id: 'sheher' } ]
        });

        const grammar = await pronounService.getUserPronouns('TestUser');
        expect(grammar.Subject).toBe('She');
        expect(grammar.object).toBe('her');
    });

    test('getUserPronouns returns null on 404 or missing ID', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            status: 404, // User not found
            json: async () => []
        });

        const grammar = await pronounService.getUserPronouns('unknown_user');
        expect(grammar).toBeNull();
    });
});
