import { Firestore, FieldValue } from '@google-cloud/firestore';
import { initializeStorage, recordGameResult, StorageError } from '../../../../src/components/geo/geoStorage.js';

// --- Mocks ---
// Mock the entire Firestore library
jest.mock('@google-cloud/firestore', () => {
    // Mock FieldValue separately as it's used directly
    const mockFieldValue = {
        serverTimestamp: jest.fn(() => 'mock-server-timestamp'), // Return a mock value
        increment: jest.fn((n) => `mock-increment-${n}`), // Mock increment if needed elsewhere
        delete: jest.fn(() => 'mock-delete'), // Mock delete if needed elsewhere
    };

    // --- Revised Firestore mocks for proper query chaining ---
    const mockGet = jest.fn().mockResolvedValue({ empty: true, size: 0, docs: [] });
    const mockAdd = jest.fn();
    const mockSet = jest.fn();
    const mockUpdate = jest.fn();
    const mockDelete = jest.fn();

    const mockLimit = jest.fn(() => ({ get: mockGet }));
    const mockOrderBy = jest.fn(() => ({ limit: mockLimit, get: mockGet }));
    const mockWhere = jest.fn(() => ({ orderBy: mockOrderBy, limit: mockLimit, get: mockGet }));

    const mockDoc = jest.fn(() => ({
        get: mockGet,
        set: mockSet,
        update: mockUpdate,
        delete: mockDelete,
    }));

    const mockCollection = jest.fn(() => ({
        add: mockAdd,
        doc: mockDoc,
        where: mockWhere,
        orderBy: mockOrderBy,
        limit: mockLimit,
        get: mockGet,
    }));

    return {
        Firestore: jest.fn().mockImplementation(() => ({
            collection: mockCollection,
            doc: mockDoc,
            batch: jest.fn(() => ({
                update: jest.fn(),
                commit: jest.fn(),
            })),
        })),
        FieldValue: mockFieldValue, // Export the mocked FieldValue
    };
});

// Mock the logger to prevent actual logging during tests
jest.mock('../../../../src/lib/logger.js', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
}));


// --- Test Suite ---
describe('GeoGame Storage - History Recording', () => {
    let mockDbInstance;
    let mockCollectionRef;
    let mockAddFn;

    beforeAll(async () => {
        // Since Firestore is mocked, initializeStorage should "succeed"
        // without actually connecting to GCP.
        await initializeStorage();
        // Get references to the mocked functions for assertions
        mockDbInstance = new Firestore(); // Get the mocked instance
        mockCollectionRef = mockDbInstance.collection;
        // Find the specific mock function for 'add' created within the mock structure
        const collectionReturnValue = mockCollectionRef(); // Call the mock collection function
        mockAddFn = collectionReturnValue.add; // Get the mock add function from the return value
    });

    beforeEach(() => {
        // Reset mocks before each test
        jest.clearAllMocks();
        // Specifically reset the call history of the mock add function
        mockAddFn.mockClear();
        mockCollectionRef.mockClear();
    });

    test('recordGameResult should add a document to the history collection', async () => {
        // --- Arrange ---
        const gameDetails = {
            channel: 'testchannel',
            mode: 'real',
            location: 'Paris',
            gameTitle: null,
            winner: 'testuser',
            winnerDisplay: 'TestUser',
            startTime: new Date(Date.now() - 60000).toISOString(), // 1 minute ago
            endTime: new Date().toISOString(),
            durationMs: 60000,
            reasonEnded: 'guessed',
            cluesGiven: 2,
            roundNumber: 1,
            totalRounds: 1,
            pointsAwarded: 20,
        };

        // --- Act ---
        await recordGameResult(gameDetails);

        // --- Assert ---
        // 1. Check if the correct collection was targeted
        expect(mockCollectionRef).toHaveBeenCalledWith('geoGameHistory');
        expect(mockCollectionRef).toHaveBeenCalledTimes(1);

        // 2. Check if the 'add' function was called
        expect(mockAddFn).toHaveBeenCalledTimes(1);

        // 3. Check the structure of the data passed to 'add'
        const expectedData = {
            ...gameDetails,
            timestamp: 'mock-server-timestamp', // Check against the mocked FieldValue
        };
        expect(mockAddFn).toHaveBeenCalledWith(expectedData);
        
        // 4. Verify logger was called (optional)
        // expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('Recorded game result')); // Example logger check
    });

    test('recordGameResult should include server timestamp', async () => {
        const gameDetails = { channel: 'testchannel', location: 'London', reasonEnded: 'timeout' };
        await recordGameResult(gameDetails);
        expect(mockAddFn).toHaveBeenCalledTimes(1);
        expect(mockAddFn).toHaveBeenCalledWith(expect.objectContaining({
            timestamp: 'mock-server-timestamp'
        }));
    });

    test('recordGameResult should throw StorageError on Firestore failure', async () => {
        // --- Arrange ---
        const gameDetails = { channel: 'errorchannel', location: 'Errorville', reasonEnded: 'guessed' };
        const firestoreError = new Error("Firestore write failed");
        mockAddFn.mockRejectedValueOnce(firestoreError); // Simulate Firestore failure for the NEXT call

        // --- Act & Assert ---
        // Check type AND message in one go
        await expect(recordGameResult(gameDetails)).rejects.toThrow(
            new StorageError('Failed to record game result', firestoreError)
        );

        // Verify mocks were called
        expect(mockCollectionRef).toHaveBeenCalledWith('geoGameHistory');
        // mockAddFn should have been called once (inside the expect)
        expect(mockAddFn).toHaveBeenCalledTimes(1);

        // Verify error was logged (optional) - Requires logger mock setup
        // expect(logger.error).toHaveBeenCalledWith(
        //     expect.objectContaining({ err: firestoreError }), // Check the error object passed to logger
        //     expect.stringContaining('Error adding document') // Check the message string
        // );
    });

    test('recordGameResult should handle missing optional fields gracefully', async () => {
        const minimalDetails = {
            channel: 'minimalchannel',
            location: 'Nowhere',
            reasonEnded: 'stopped',
            // Intentionally missing: mode, gameTitle, winner, startTime, etc.
        };

        await recordGameResult(minimalDetails);

        expect(mockAddFn).toHaveBeenCalledTimes(1);
        // Expect ONLY the fields from minimalDetails plus the timestamp
        expect(mockAddFn).toHaveBeenCalledWith({
            channel: 'minimalchannel',
            location: 'Nowhere',
            reasonEnded: 'stopped',
            timestamp: 'mock-server-timestamp', // The only field added by the function
        });
    });
});