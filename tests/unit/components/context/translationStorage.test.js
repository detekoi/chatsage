// tests/unit/components/context/translationStorage.test.js

jest.mock('@google-cloud/firestore', () => {
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

    return {
        Firestore: jest.fn().mockImplementation(() => ({
            collection: mockCollection,
        })),
    };
});

jest.mock('../../../../src/lib/logger.js', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

import { Firestore } from '@google-cloud/firestore';
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
        mockDbInstance = new Firestore();
        mockCollectionRef = mockDbInstance.collection;
        mockDocRef = mockCollectionRef().doc;
    });

    describe('saveUserTranslation', () => {
        test('should save translation preference to Firestore', async () => {
            const mockSet = mockDocRef().set;
            mockSet.mockResolvedValue();

            const result = await saveUserTranslation('testchannel', 'testuser', 'spanish');

            expect(result).toBe(true);
            expect(mockCollectionRef).toHaveBeenCalledWith('userTranslations');
            expect(mockDocRef).toHaveBeenCalledWith('testchannel:testuser');
            expect(mockSet).toHaveBeenCalledWith(
                expect.objectContaining({
                    channelName: 'testchannel',
                    username: 'testuser',
                    targetLanguage: 'spanish',
                    updatedAt: expect.any(Date),
                }),
                { merge: true }
            );
        });

        test('should return false on Firestore error', async () => {
            const mockSet = mockDocRef().set;
            mockSet.mockRejectedValue(new Error('Firestore write failed'));

            const result = await saveUserTranslation('testchannel', 'testuser', 'spanish');

            expect(result).toBe(false);
        });

        test('should use lowercase channel and username for doc ID', async () => {
            const mockSet = mockDocRef().set;
            mockSet.mockResolvedValue();

            await saveUserTranslation('TestChannel', 'TestUser', 'french');

            expect(mockDocRef).toHaveBeenCalledWith('testchannel:testuser');
        });
    });

    describe('removeUserTranslation', () => {
        test('should delete translation document from Firestore', async () => {
            const mockDeleteFn = mockDocRef().delete;
            mockDeleteFn.mockResolvedValue();

            const result = await removeUserTranslation('testchannel', 'testuser');

            expect(result).toBe(true);
            expect(mockCollectionRef).toHaveBeenCalledWith('userTranslations');
            expect(mockDocRef).toHaveBeenCalledWith('testchannel:testuser');
            expect(mockDeleteFn).toHaveBeenCalled();
        });

        test('should return false on Firestore error', async () => {
            const mockDeleteFn = mockDocRef().delete;
            mockDeleteFn.mockRejectedValue(new Error('Firestore delete failed'));

            const result = await removeUserTranslation('testchannel', 'testuser');

            expect(result).toBe(false);
        });
    });

    describe('loadAllUserTranslations', () => {
        test('should load all translations from Firestore', async () => {
            const mockDocs = [
                { data: () => ({ channelName: 'channel1', username: 'user1', targetLanguage: 'spanish' }) },
                { data: () => ({ channelName: 'channel2', username: 'user2', targetLanguage: 'french' }) },
            ];
            const mockGetAll = mockCollectionRef().get;
            mockGetAll.mockResolvedValue({
                forEach: (fn) => mockDocs.forEach(fn),
            });

            const result = await loadAllUserTranslations();

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({ channelName: 'channel1', username: 'user1', targetLanguage: 'spanish' });
            expect(result[1]).toEqual({ channelName: 'channel2', username: 'user2', targetLanguage: 'french' });
        });

        test('should skip documents with missing fields', async () => {
            const mockDocs = [
                { data: () => ({ channelName: 'channel1', username: 'user1', targetLanguage: 'spanish' }) },
                { data: () => ({ channelName: 'channel2', username: 'user2' }) }, // Missing targetLanguage
            ];
            const mockGetAll = mockCollectionRef().get;
            mockGetAll.mockResolvedValue({
                forEach: (fn) => mockDocs.forEach(fn),
            });

            const result = await loadAllUserTranslations();

            expect(result).toHaveLength(1);
        });

        test('should return empty array on Firestore error', async () => {
            const mockGetAll = mockCollectionRef().get;
            mockGetAll.mockRejectedValue(new Error('Firestore read failed'));

            const result = await loadAllUserTranslations();

            expect(result).toEqual([]);
        });
    });
});
