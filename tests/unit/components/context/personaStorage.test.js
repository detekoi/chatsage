// tests/unit/components/context/personaStorage.test.js

const mockDocs = [];
let mockDefaultsDoc = { exists: false, data: () => ({}) };
const mockDefaultsSet = jest.fn().mockResolvedValue();

jest.mock('../../../../src/lib/firestore.js', () => {
    const mockCollectionGet = jest.fn(async () => ({
        forEach: (cb) => mockDocs.forEach(cb),
    }));

    const mockCollection = jest.fn((name) => {
        if (name === 'botDefaults') {
            return {
                doc: jest.fn(() => ({
                    get: jest.fn(async () => mockDefaultsDoc),
                    set: mockDefaultsSet,
                })),
            };
        }
        return { get: mockCollectionGet, onSnapshot: jest.fn() };
    });

    return { getFirestore: jest.fn(() => ({ collection: mockCollection })) };
});

jest.mock('../../../../src/lib/allowList.js', () => ({
    getBroadcasterIdForChannel: jest.fn(),
}));

jest.mock('../../../../src/lib/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const {
    normalizePersona,
    loadAllChannelPersonas,
    getCachedPersona,
    getCachedPersonaById,
    publishBotDefaults,
    _clearPersonaCache,
    MAX_PERSONA_LENGTH,
} = require('../../../../src/components/context/personaStorage.js');

const { getBroadcasterIdForChannel } = require('../../../../src/lib/allowList.js');

const doc = (id, data) => ({ id, data: () => data });

beforeEach(() => {
    jest.clearAllMocks();
    _clearPersonaCache();
    mockDocs.length = 0;
    mockDefaultsDoc = { exists: false, data: () => ({}) };
});

describe('normalizePersona', () => {
    it('accepts an approved, non-empty persona and trims it', () => {
        expect(normalizePersona({ status: 'approved', instructions: '  hi  ' })).toBe('hi');
    });

    it.each([
        ['a missing status', { instructions: 'hi' }],
        ['a pending status', { status: 'pending', instructions: 'hi' }],
        ['a rejected status', { status: 'rejected', instructions: 'hi' }],
        ['whitespace-only instructions', { status: 'approved', instructions: '   ' }],
        ['missing instructions', { status: 'approved' }],
        ['a null document', null],
    ])('rejects %s', (_label, data) => {
        expect(normalizePersona(data)).toBeNull();
    });

    it('re-clamps over-length text, since a doc can be edited outside the API', () => {
        const result = normalizePersona({ status: 'approved', instructions: 'x'.repeat(9000) });
        expect(result).toHaveLength(MAX_PERSONA_LENGTH);
    });
});

describe('loadAllChannelPersonas', () => {
    it('caches only approved personas, keyed by broadcaster ID', async () => {
        mockDocs.push(
            doc('100', { status: 'approved', instructions: 'Alice persona.' }),
            doc('200', { status: 'pending', instructions: 'Not yet screened.' }),
            doc('300', { status: 'approved', instructions: 'Zeta persona.' }),
        );

        const cache = await loadAllChannelPersonas();

        expect(cache.size).toBe(2);
        expect(getCachedPersonaById('100')).toBe('Alice persona.');
        expect(getCachedPersonaById('300')).toBe('Zeta persona.');
        expect(getCachedPersonaById('200')).toBeNull();
    });

    it('never caches a non-approved persona', async () => {
        mockDocs.push(doc('100', { status: 'rejected', instructions: 'bad stuff' }));
        await loadAllChannelPersonas();
        expect(getCachedPersonaById('100')).toBeNull();
    });
});

describe('getCachedPersona', () => {
    beforeEach(async () => {
        mockDocs.push(doc('100', { status: 'approved', instructions: 'Alice persona.' }));
        await loadAllChannelPersonas();
    });

    it('resolves a channel name through the broadcaster ID map', () => {
        getBroadcasterIdForChannel.mockReturnValue('100');
        expect(getCachedPersona('alice')).toBe('Alice persona.');
    });

    it('falls back to the default when the channel has no known broadcaster ID', () => {
        // Legacy managedChannels docs predate twitchUserId; failing to the default
        // persona is the safe direction.
        getBroadcasterIdForChannel.mockReturnValue(null);
        expect(getCachedPersona('legacychannel')).toBeNull();
    });

    it('returns null for a channel whose ID has no persona', () => {
        getBroadcasterIdForChannel.mockReturnValue('999');
        expect(getCachedPersona('other')).toBeNull();
    });
});

describe('publishBotDefaults', () => {
    it('writes when no document exists yet', async () => {
        const wrote = await publishBotDefaults('persona text', 'core text');

        expect(wrote).toBe(true);
        expect(mockDefaultsSet).toHaveBeenCalledTimes(1);
        const payload = mockDefaultsSet.mock.calls[0][0];
        expect(payload.persona).toBe('persona text');
        expect(payload.core).toBe('core text');
        expect(payload.maxLength).toBe(MAX_PERSONA_LENGTH);
        expect(payload.hash).toEqual(expect.any(String));
    });

    it('skips the write when the content hash is unchanged', async () => {
        await publishBotDefaults('persona text', 'core text');
        const { hash } = mockDefaultsSet.mock.calls[0][0];
        mockDefaultsSet.mockClear();

        mockDefaultsDoc = { exists: true, data: () => ({ hash }) };
        const wrote = await publishBotDefaults('persona text', 'core text');

        expect(wrote).toBe(false);
        expect(mockDefaultsSet).not.toHaveBeenCalled();
    });

    it('writes again when the text changes', async () => {
        await publishBotDefaults('persona text', 'core text');
        const { hash } = mockDefaultsSet.mock.calls[0][0];
        mockDefaultsSet.mockClear();

        mockDefaultsDoc = { exists: true, data: () => ({ hash }) };
        const wrote = await publishBotDefaults('persona text EDITED', 'core text');

        expect(wrote).toBe(true);
        expect(mockDefaultsSet).toHaveBeenCalledTimes(1);
    });
});
