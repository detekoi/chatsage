// tests/unit/components/llm/inferenceHistoryStorage.test.js

jest.mock('../../../../src/lib/logger.js');
jest.mock('../../../../src/lib/firestore.js');

import {
    logInference, getRecentInferences,
    CHECKIN_SOURCE, customCommandSource,
} from '../../../../src/components/llm/inferenceHistoryStorage.js';
import { getFirestore, Timestamp, createExpiresAt } from '../../../../src/lib/firestore.js';

describe('inferenceHistoryStorage', () => {
    let mockDb;
    let mockCollection;
    let mockDoc;
    let mockSubCollection;
    let mockAdd;
    let mockGet;

    beforeEach(() => {
        jest.clearAllMocks();

        mockAdd = jest.fn().mockResolvedValue({ id: 'test-doc-id' });
        mockGet = jest.fn();

        mockSubCollection = jest.fn().mockReturnValue({
            add: mockAdd,
            where: jest.fn().mockReturnValue({
                orderBy: jest.fn().mockReturnValue({
                    limit: jest.fn().mockReturnValue({
                        get: mockGet,
                    }),
                }),
            }),
        });

        mockDoc = jest.fn().mockReturnValue({
            collection: mockSubCollection,
        });

        mockCollection = jest.fn().mockReturnValue({
            doc: mockDoc,
        });

        mockDb = { collection: mockCollection };
        getFirestore.mockReturnValue(mockDb);

        Timestamp.fromDate = jest.fn((date) => ({ _date: date, toDate: () => date }));
        createExpiresAt.mockImplementation((days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000));
    });

    // ─── Source key constants ────────────────────────────────────────────────

    describe('source key constants', () => {
        test('CHECKIN_SOURCE is a string constant', () => {
            expect(CHECKIN_SOURCE).toBe('checkin');
        });

        test('customCommandSource returns prefixed source key', () => {
            expect(customCommandSource('hug')).toBe('custom:hug');
            expect(customCommandSource('vibecheck')).toBe('custom:vibecheck');
        });
    });

    // ─── logInference ───────────────────────────────────────────────────────

    describe('logInference', () => {
        test('writes document with correct structure (no prompt field)', async () => {
            await logInference('testchannel', 'custom:hug', 'Big hug for User!');

            expect(mockCollection).toHaveBeenCalledWith('inferenceHistory');
            expect(mockDoc).toHaveBeenCalledWith('testchannel');
            expect(mockSubCollection).toHaveBeenCalledWith('responses');
            expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({
                source: 'custom:hug',
                response: 'Big hug for User!',
                createdAt: expect.anything(),
                expiresAt: expect.anything(),
            }));
            // Verify prompt field is NOT written
            const addCallArg = mockAdd.mock.calls[0][0];
            expect(addCallArg).not.toHaveProperty('prompt');
        });

        test('uses shared createExpiresAt for TTL', async () => {
            await logInference('testchannel', 'checkin', 'response');

            expect(createExpiresAt).toHaveBeenCalledWith(14);
        });

        test('does not throw on Firestore error', async () => {
            mockAdd.mockRejectedValue(new Error('Firestore write failed'));

            // Should not throw
            await expect(logInference('testchannel', 'checkin', 'r')).resolves.toBeUndefined();
        });
    });

    // ─── getRecentInferences ────────────────────────────────────────────────

    describe('getRecentInferences', () => {
        test('returns array of response strings', async () => {
            mockGet.mockResolvedValue({
                forEach: (fn) => {
                    fn({ data: () => ({ response: 'response 1' }) });
                    fn({ data: () => ({ response: 'response 2' }) });
                    fn({ data: () => ({ response: 'response 3' }) });
                },
            });

            const result = await getRecentInferences('testchannel', 'custom:hug');

            expect(result).toEqual(['response 1', 'response 2', 'response 3']);
        });

        test('queries with correct collection path', async () => {
            mockGet.mockResolvedValue({ forEach: () => {} });

            await getRecentInferences('testchannel', 'checkin', 3);

            expect(mockDoc).toHaveBeenCalledWith('testchannel');
            expect(mockSubCollection).toHaveBeenCalledWith('responses');
        });

        test('returns empty array on Firestore error', async () => {
            mockGet.mockRejectedValue(new Error('Firestore read failed'));

            const result = await getRecentInferences('testchannel', 'checkin');
            expect(result).toEqual([]);
        });

        test('skips entries with no response field', async () => {
            mockGet.mockResolvedValue({
                forEach: (fn) => {
                    fn({ data: () => ({ response: 'valid' }) });
                    fn({ data: () => ({ response: null }) });
                    fn({ data: () => ({ prompt: 'no response field' }) });
                },
            });

            const result = await getRecentInferences('testchannel', 'custom:test');
            expect(result).toEqual(['valid']);
        });
    });
});
