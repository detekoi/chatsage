import { pronounService, buildGrammar } from '../../../src/lib/pronounService.js';

// Mock the global fetch
const originalFetch = global.fetch;

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });
const errorResponse = (status) => ({ ok: false, status, json: async () => { throw new Error('no body'); } });

describe('pronounService', () => {
    beforeEach(() => {
        pronounService.userPronounsCache.cache.clear();
        pronounService.pendingRequests.clear();
        pronounService.backoffUntil = 0;

        global.fetch = jest.fn();
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    test('calls the v1 API with the lowercased login', async () => {
        global.fetch.mockResolvedValueOnce(okResponse({
            channel_id: '1', channel_login: 'testuser', pronoun_id: 'sheher', alt_pronoun_id: null,
        }));

        await pronounService.getUserPronouns('TestUser');
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(global.fetch.mock.calls[0][0]).toBe('https://api.pronouns.alejo.io/v1/users/testuser');
        expect(global.fetch.mock.calls[0][1].headers).toEqual(expect.objectContaining({
            'Accept': 'application/json',
            'User-Agent': expect.stringContaining('github.com/detekoi'),
        }));
    });

    test('getUserPronouns returns full grammar from a v1 object response', async () => {
        global.fetch.mockResolvedValueOnce(okResponse({
            channel_id: '1', channel_login: 'testuser', pronoun_id: 'sheher', alt_pronoun_id: null,
        }));

        const grammar = await pronounService.getUserPronouns('TestUser');
        expect(grammar.display).toBe('She/Her');
        expect(grammar.Subject).toBe('She');
        expect(grammar.object).toBe('her');
        expect(grammar.reflexive).toBe('herself');
    });

    test('mixed pronouns use alt_pronoun_id for display and primary for grammar', async () => {
        global.fetch.mockResolvedValueOnce(okResponse({
            channel_id: '2', channel_login: 'mixed', pronoun_id: 'hehim', alt_pronoun_id: 'theythem',
        }));

        const grammar = await pronounService.getUserPronouns('mixed');
        expect(grammar.display).toBe('He/They');
        expect(grammar.Subject).toBe('He');
        expect(grammar.possessive).toBe('his');
    });

    test('singular sets display their label and fall back to they/them grammar', async () => {
        global.fetch.mockResolvedValueOnce(okResponse({
            channel_id: '3', channel_login: 'anyone', pronoun_id: 'any',
        }));

        const grammar = await pronounService.getUserPronouns('anyone');
        expect(grammar.display).toBe('Any');
        expect(grammar.Subject).toBe('They');
        expect(grammar.reflexive).toBe('themself');
    });

    test('getUserPronouns returns null on 404 and caches the miss', async () => {
        global.fetch.mockResolvedValueOnce(errorResponse(404));

        expect(await pronounService.getUserPronouns('unknown_user')).toBeNull();
        expect(await pronounService.getUserPronouns('unknown_user')).toBeNull();
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('getUserPronouns returns null for an unknown pronoun id', async () => {
        global.fetch.mockResolvedValueOnce(okResponse({
            channel_id: '4', channel_login: 'novel', pronoun_id: 'brand_new_id',
        }));

        expect(await pronounService.getUserPronouns('novel')).toBeNull();
    });

    test('getUserPronouns returns null when the body has no pronoun_id', async () => {
        global.fetch.mockResolvedValueOnce(okResponse({}));

        expect(await pronounService.getUserPronouns('empty')).toBeNull();
    });

    test('server errors are negatively cached for a short window only', async () => {
        global.fetch.mockResolvedValueOnce(errorResponse(429));
        expect(await pronounService.getUserPronouns('ratelimited')).toBeNull();

        // Immediately after: still served from the negative cache
        expect(await pronounService.getUserPronouns('ratelimited')).toBeNull();
        expect(global.fetch).toHaveBeenCalledTimes(1);

        // Entry is stamped so it expires after NEGATIVE_CACHE_TTL_MS, not CACHE_TTL_MS
        const entry = pronounService.userPronounsCache.get('ratelimited');
        expect(Date.now() - entry.fetchedAt).toBeGreaterThanOrEqual(
            pronounService.CACHE_TTL_MS - pronounService.NEGATIVE_CACHE_TTL_MS - 1000,
        );
    });

    test('a 429 or 5xx pauses lookups for other users until the negative window passes', async () => {
        global.fetch.mockResolvedValueOnce(errorResponse(503));
        expect(await pronounService.getUserPronouns('first')).toBeNull();
        expect(pronounService.backoffUntil).toBeGreaterThan(Date.now());

        // A different, uncached user does not hit the API while backed off
        expect(await pronounService.getUserPronouns('second')).toBeNull();
        expect(global.fetch).toHaveBeenCalledTimes(1);

        // Already-cached positive entries are still served
        pronounService.userPronounsCache.set('third', { pronounId: 'hehim', altPronounId: null, fetchedAt: Date.now() });
        expect((await pronounService.getUserPronouns('third')).display).toBe('He/Him');

        // Once the window passes, requests resume
        pronounService.backoffUntil = Date.now() - 1;
        global.fetch.mockResolvedValueOnce(okResponse({ pronoun_id: 'sheher' }));
        expect((await pronounService.getUserPronouns('second')).display).toBe('She/Her');
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('a 404 does not trigger the global backoff', async () => {
        global.fetch.mockResolvedValueOnce(errorResponse(404));
        await pronounService.getUserPronouns('nobody');
        expect(pronounService.backoffUntil).toBe(0);
    });

    test('network errors return null and are not cached', async () => {
        global.fetch.mockRejectedValueOnce(new Error('boom'));
        expect(await pronounService.getUserPronouns('flaky')).toBeNull();

        global.fetch.mockResolvedValueOnce(okResponse({ pronoun_id: 'theythem' }));
        expect((await pronounService.getUserPronouns('flaky')).display).toBe('They/Them');
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('concurrent lookups for the same login share one request', async () => {
        global.fetch.mockResolvedValueOnce(okResponse({ pronoun_id: 'xexem' }));

        const [a, b] = await Promise.all([
            pronounService.getUserPronouns('dupe'),
            pronounService.getUserPronouns('dupe'),
        ]);
        expect(a.display).toBe('Xe/Xem');
        expect(b.display).toBe('Xe/Xem');
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('invalid logins are rejected without a request', async () => {
        expect(await pronounService.getUserPronouns('bad name!')).toBeNull();
        expect(await pronounService.getUserPronouns('')).toBeNull();
        expect(await pronounService.getUserPronouns(null)).toBeNull();
        expect(await pronounService.getUserPronouns(12345)).toBeNull();
        expect(await pronounService.getUserPronouns({ login: 'x' })).toBeNull();
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

describe('buildGrammar', () => {
    test('plain set displays Subject/Object', () => {
        expect(buildGrammar('faefaer', null).display).toBe('Fae/Faer');
        expect(buildGrammar('hehim', null).display).toBe('He/Him');
    });

    test('itits displays It/Its while keeping "it" as the grammatical object', () => {
        const g = buildGrammar('itits', null);
        expect(g.display).toBe('It/Its');
        expect(g.object).toBe('it');
        expect(g.possessive).toBe('its');
    });

    test('itits as an alt uses its subject', () => {
        expect(buildGrammar('sheher', 'itits').display).toBe('She/It');
    });

    test('an alt equal to the primary is treated as no alt', () => {
        expect(buildGrammar('hehim', 'hehim').display).toBe('He/Him');
        expect(buildGrammar('itits', 'itits').display).toBe('It/Its');
    });

    test('alt set displays Subject/AltSubject', () => {
        expect(buildGrammar('sheher', 'theythem').display).toBe('She/They');
        expect(buildGrammar('sheher', 'hehim').display).toBe('She/He');
    });

    test('unknown alt id is ignored', () => {
        expect(buildGrammar('sheher', 'nope').display).toBe('She/Her');
    });

    test('singular alt uses its label', () => {
        expect(buildGrammar('hehim', 'any').display).toBe('He/Any');
    });

    test('singular primary ignores alt', () => {
        expect(buildGrammar('other', 'hehim').display).toBe('Other');
    });

    test('prototype keys are not treated as pronoun ids', () => {
        expect(buildGrammar('constructor', null)).toBeNull();
        expect(buildGrammar('hehim', 'toString').display).toBe('He/Him');
    });

    test('null id returns null', () => {
        expect(buildGrammar(null, null)).toBeNull();
        expect(buildGrammar(undefined, 'hehim')).toBeNull();
    });
});
