// tests/unit/components/context/translationStorage.test.js

jest.mock('../../../../src/lib/firestore.js', () => {
    const mockGet = jest.fn().mockResolvedValue({ size: 0, forEach: jest.fn() });
    const mockSet = jest.fn().mockResolvedValue();
    const mockDelete = jest.fn().mockResolvedValue();

    const mockDoc = jest.fn(() => ({
        get: mockGet,
        set: mockSet,
        delete: mockDelete,
    }));

    const mockCollection = jest.fn(() => ({
        doc: mockDoc,
        get: mockGet,
    }));

    const mockDbInstance = {
        collection: mockCollection,
    };

    return {
        getFirestore: jest.fn(() => mockDbInstance),
        FieldValue: {},
        Timestamp: { fromDate: jest.fn((d) => d) },
    };
});

jest.mock('../../../../src/lib/allowList.js', () => ({
    getBroadcasterIdForChannel: jest.fn((name) => ({ testchannel: '4242', channel2: '4343' })[String(name).toLowerCase()] || null),
    getChannelNameForBroadcasterId: jest.fn((id) => ({ 4242: 'testchannel', 4343: 'channel2' })[id] || null),
}));

jest.mock('../../../../src/lib/logger.js', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

import { getFirestore } from '../../../../src/lib/firestore.js';
import logger from '../../../../src/lib/logger.js';
import {
    saveUserTranslation,
    removeUserTranslation,
    loadAllUserTranslations,
} from '../../../../src/components/context/translationStorage.js';

describe('translationStorage', () => {
    let mockDbInstance;
    let mockCollectionRef;
    let mockDocRef;

    beforeEach(() => {
        jest.clearAllMocks();
        mockDbInstance = getFirestore();
        mockCollectionRef = mockDbInstance.collection;
        mockDocRef = mockCollectionRef().doc;
    });

    function mockSnapshot(docs) {
        mockCollectionRef().get.mockResolvedValue({
            forEach: (fn) => docs.forEach(fn),
        });
    }

    describe('saveUserTranslation', () => {
        test('keys the document by <broadcasterId>:<userId> and stores the login for readability', async () => {
            const mockSet = mockDocRef().set;
            mockSet.mockResolvedValue();

            const result = await saveUserTranslation('testchannel', '9001', 'TestUser', 'spanish');

            expect(result).toBe(true);
            expect(mockCollectionRef).toHaveBeenCalledWith('userTranslations');
            expect(mockDocRef).toHaveBeenCalledWith('4242:9001');
            expect(mockSet).toHaveBeenCalledWith(
                {
                    channelName: 'testchannel',
                    userId: '9001',
                    login: 'testuser',
                    targetLanguage: 'spanish',
                    updatedAt: expect.any(Date),
                },
                { merge: true }
            );
        });

        test('resolves the channel case-insensitively', async () => {
            await saveUserTranslation('#TestChannel', '9001', 'testuser', 'french');

            expect(mockDocRef).toHaveBeenCalledWith('4242:9001');
        });

        test('should return false on Firestore error', async () => {
            const mockSet = mockDocRef().set;
            mockSet.mockRejectedValue(new Error('Firestore write failed'));

            const result = await saveUserTranslation('testchannel', '9001', 'testuser', 'spanish');

            expect(result).toBe(false);
        });

        test('returns false without writing for a channel with no known broadcaster ID', async () => {
            const mockSet = mockDocRef().set;
            mockDocRef.mockClear();

            const result = await saveUserTranslation('unknownchannel', '9001', 'testuser', 'spanish');

            expect(result).toBe(false);
            expect(mockDocRef).not.toHaveBeenCalled();
            expect(mockSet).not.toHaveBeenCalled();
        });

        test('returns false without writing for a missing or non-numeric user ID', async () => {
            mockDocRef.mockClear();

            expect(await saveUserTranslation('testchannel', null, 'testuser', 'spanish')).toBe(false);
            expect(await saveUserTranslation('testchannel', 'testuser', 'testuser', 'spanish')).toBe(false);
            expect(mockDocRef).not.toHaveBeenCalled();
        });
    });

    describe('removeUserTranslation', () => {
        test('should delete the ID-keyed translation document', async () => {
            const mockDeleteFn = mockDocRef().delete;
            mockDeleteFn.mockResolvedValue();

            const result = await removeUserTranslation('testchannel', '9001');

            expect(result).toBe(true);
            expect(mockCollectionRef).toHaveBeenCalledWith('userTranslations');
            expect(mockDocRef).toHaveBeenCalledWith('4242:9001');
            expect(mockDeleteFn).toHaveBeenCalled();
        });

        test('should return false on Firestore error', async () => {
            const mockDeleteFn = mockDocRef().delete;
            mockDeleteFn.mockRejectedValue(new Error('Firestore delete failed'));

            const result = await removeUserTranslation('testchannel', '9001');

            expect(result).toBe(false);
        });
    });

    describe('loadAllUserTranslations', () => {
        test('maps each document back to the current channel login and user ID', async () => {
            mockSnapshot([
                { id: '4242:9001', data: () => ({ channelName: 'testchannel', userId: '9001', login: 'user1', targetLanguage: 'spanish' }) },
                // Stored channelName is stale (channel renamed); the allow-list mapping wins
                { id: '4343:9002', data: () => ({ channelName: 'oldname', userId: '9002', login: 'user2', targetLanguage: 'french' }) },
            ]);

            const result = await loadAllUserTranslations();

            expect(result).toEqual([
                { channelName: 'testchannel', userId: '9001', login: 'user1', targetLanguage: 'spanish' },
                { channelName: 'channel2', userId: '9002', login: 'user2', targetLanguage: 'french' },
            ]);
        });

        test('takes the user ID from the document ID and tolerates a missing login', async () => {
            mockSnapshot([
                { id: '4242:9001', data: () => ({ channelName: 'testchannel', targetLanguage: 'spanish' }) },
            ]);

            const result = await loadAllUserTranslations();

            expect(result).toEqual([
                { channelName: 'testchannel', userId: '9001', login: null, targetLanguage: 'spanish' },
            ]);
        });

        test('skips legacy login-keyed documents with a debug log', async () => {
            mockSnapshot([
                { id: 'testchannel:user1', data: () => ({ channelName: 'testchannel', username: 'user1', targetLanguage: 'spanish' }) },
                { id: '4242:user1', data: () => ({ channelName: 'testchannel', username: 'user1', targetLanguage: 'spanish' }) },
                { id: '4242:9001', data: () => ({ channelName: 'testchannel', userId: '9001', login: 'user1', targetLanguage: 'german' }) },
            ]);

            const result = await loadAllUserTranslations();

            expect(result).toEqual([
                { channelName: 'testchannel', userId: '9001', login: 'user1', targetLanguage: 'german' },
            ]);
            expect(logger.debug).toHaveBeenCalledWith(
                { docId: 'testchannel:user1' },
                expect.stringContaining('legacy')
            );
        });

        test('should skip documents with missing targetLanguage', async () => {
            mockSnapshot([
                { id: '4242:9001', data: () => ({ channelName: 'testchannel', userId: '9001', targetLanguage: 'spanish' }) },
                { id: '4242:9002', data: () => ({ channelName: 'testchannel', userId: '9002' }) },
            ]);

            const result = await loadAllUserTranslations();

            expect(result).toHaveLength(1);
        });

        test('falls back to the stored channelName for a broadcaster no longer in the allow-list', async () => {
            mockSnapshot([
                { id: '7777:9001', data: () => ({ channelName: 'removedchannel', userId: '9001', targetLanguage: 'spanish' }) },
            ]);

            const result = await loadAllUserTranslations();

            expect(result).toEqual([
                { channelName: 'removedchannel', userId: '9001', login: null, targetLanguage: 'spanish' },
            ]);
        });

        test('should return empty array on Firestore error', async () => {
            const mockGetAll = mockCollectionRef().get;
            mockGetAll.mockRejectedValue(new Error('Firestore read failed'));

            const result = await loadAllUserTranslations();

            expect(result).toEqual([]);
        });
    });
});
