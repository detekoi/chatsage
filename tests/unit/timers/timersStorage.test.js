// tests/unit/timers/timersStorage.test.js
import {
    findUnsupportedTimerVariables,
    addTimer,
    MAX_TIMERS_PER_CHANNEL,
    TimersStorageError,
} from '../../../src/components/timers/timersStorage.js';
import { getFirestore } from '../../../src/lib/firestore.js';

jest.mock('../../../src/lib/logger.js', () => ({
    __esModule: true,
    default: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

jest.mock('../../../src/lib/firestore.js', () => ({
    getFirestore: jest.fn(),
    FieldValue: {
        serverTimestamp: jest.fn(() => 'server-timestamp'),
        increment: jest.fn((n) => ({ _isIncrement: true, _incrementValue: n })),
    },
}));

describe('findUnsupportedTimerVariables', () => {
    test('returns empty for plain text', () => {
        expect(findUnsupportedTimerVariables('Join the Discord!')).toEqual([]);
    });

    test('allows channel-scoped variables', () => {
        expect(findUnsupportedTimerVariables(
            'Playing $(game) for $(uptime) in $(channel), run $(count), roll $(random 1-100)')).toEqual([]);
    });

    test('detects user-dependent variables', () => {
        expect(findUnsupportedTimerVariables('Hi $(user), you said $(args)')).toEqual(['$(user)', '$(args)']);
        expect(findUnsupportedTimerVariables('First arg: $(1)')).toEqual(['$(1)']);
        expect(findUnsupportedTimerVariables('$(followage) and $(pronouns)')).toEqual(['$(followage)', '$(pronouns)']);
        expect(findUnsupportedTimerVariables('$(pronoun_subject) $(checkin_count)')).toEqual(['$(pronoun_subject)', '$(checkin_count)']);
    });

    test('deduplicates repeated offenders', () => {
        expect(findUnsupportedTimerVariables('$(user) $(user)')).toEqual(['$(user)']);
    });

    test('handles empty and non-string input', () => {
        expect(findUnsupportedTimerVariables('')).toEqual([]);
        expect(findUnsupportedTimerVariables(null)).toEqual([]);
        expect(findUnsupportedTimerVariables(undefined)).toEqual([]);
    });
});

describe('addTimer', () => {
    let mockDocRef;
    let mockParentDocRef;
    let timerCount;

    beforeEach(() => {
        jest.clearAllMocks();
        timerCount = 0;

        mockDocRef = {
            get: jest.fn(async () => ({ exists: false })),
            set: jest.fn(async () => {}),
        };
        mockParentDocRef = {
            set: jest.fn(async () => {}),
            collection: jest.fn(() => ({
                doc: jest.fn(() => mockDocRef),
                count: jest.fn(() => ({
                    get: jest.fn(async () => ({ data: () => ({ count: timerCount }) })),
                })),
            })),
        };
        getFirestore.mockReturnValue({
            collection: jest.fn(() => ({ doc: jest.fn(() => mockParentDocRef) })),
        });
    });

    test('creates a timer with full document shape', async () => {
        const created = await addTimer('TestChannel', 'Promo', 'Hello!', 'ModUser', 'text', 30, 10);
        expect(created).toBe(true);
        expect(mockDocRef.set).toHaveBeenCalledWith(expect.objectContaining({
            response: 'Hello!',
            type: 'text',
            intervalMinutes: 30,
            minChatLines: 10,
            enabled: true,
            useCount: 0,
            lastRunAt: null,
            createdBy: 'moduser',
        }));
        // Parent doc is created so channel docs are listable
        expect(mockParentDocRef.set).toHaveBeenCalledWith(
            expect.objectContaining({ channelName: 'testchannel' }),
            { merge: true },
        );
    });

    test('returns false when the timer already exists', async () => {
        mockDocRef.get.mockResolvedValue({ exists: true });
        const created = await addTimer('chan', 'promo', 'Hello!', 'mod');
        expect(created).toBe(false);
        expect(mockDocRef.set).not.toHaveBeenCalled();
    });

    test('throws when the channel is at the timer limit', async () => {
        timerCount = MAX_TIMERS_PER_CHANNEL;
        await expect(addTimer('chan', 'promo', 'Hello!', 'mod'))
            .rejects.toThrow(TimersStorageError);
        expect(mockDocRef.set).not.toHaveBeenCalled();
    });
});
