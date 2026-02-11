// tests/unit/customCommands/customCommandsStorage.test.js
import {
    initializeCustomCommandsStorage,
    addCustomCommand,
    getCustomCommand,
    getAllCustomCommands,
    updateCustomCommand,
    updateCustomCommandOptions,
    removeCustomCommand,
    incrementUseCount,
    loadAllCustomCommands,
} from '../../../src/components/customCommands/customCommandsStorage.js';

// Mock logger
jest.mock('../../../src/lib/logger.js', () => ({
    __esModule: true,
    default: {
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
        error: jest.fn(),
    },
}));

// --- Firestore Mock ---
// Build a mock Firestore that tracks documents in-memory
const mockStore = {};

function getOrCreateDoc(path) {
    if (!mockStore[path]) {
        mockStore[path] = { exists: false, data: null };
    }
    return mockStore[path];
}

const mockDocRef = (path) => ({
    get: jest.fn(async () => {
        const doc = getOrCreateDoc(path);
        return {
            exists: doc.exists,
            data: () => doc.data,
            id: path.split('/').pop(),
        };
    }),
    set: jest.fn(async (data, _options) => {
        mockStore[path] = {
            exists: true,
            data: { ...getOrCreateDoc(path).data, ...data },
        };
    }),
    update: jest.fn(async (data) => {
        if (!getOrCreateDoc(path).exists) {
            throw new Error('Document does not exist');
        }
        // Simulate FieldValue.increment
        const existing = mockStore[path].data || {};
        for (const [key, value] of Object.entries(data)) {
            if (value && typeof value === 'object' && value._isIncrement) {
                existing[key] = (existing[key] || 0) + value._incrementValue;
            } else {
                existing[key] = value;
            }
        }
        mockStore[path].data = existing;
    }),
    delete: jest.fn(async () => {
        delete mockStore[path];
    }),
});

const mockCollectionRef = (basePath) => {
    const colRef = {
        doc: jest.fn((docId) => {
            const fullPath = `${basePath}/${docId}`;
            return {
                ...mockDocRef(fullPath),
                collection: jest.fn((subCol) => mockCollectionRef(`${fullPath}/${subCol}`)),
                listCollections: jest.fn(async () => []),
            };
        }),
        get: jest.fn(async () => {
            // Simulate getting all docs in this collection
            const docs = [];
            const prefix = basePath + '/';
            for (const [key, val] of Object.entries(mockStore)) {
                if (key.startsWith(prefix) && val.exists) {
                    // Only match direct children (no further slashes after the prefix)
                    const remainder = key.slice(prefix.length);
                    if (!remainder.includes('/')) {
                        docs.push({
                            id: remainder,
                            data: () => val.data,
                        });
                    }
                }
            }
            return {
                forEach: (cb) => docs.forEach(cb),
                empty: docs.length === 0,
                docs,
            };
        }),
        limit: jest.fn(function () { return colRef; }),
    };
    return colRef;
};

const mockFirestore = {
    collection: jest.fn((colName) => mockCollectionRef(colName)),
};

jest.mock('@google-cloud/firestore', () => ({
    Firestore: jest.fn(() => mockFirestore),
    FieldValue: {
        serverTimestamp: jest.fn(() => new Date().toISOString()),
        increment: jest.fn((val) => ({ _isIncrement: true, _incrementValue: val })),
    },
}));

describe('customCommandsStorage', () => {
    beforeAll(async () => {
        await initializeCustomCommandsStorage();
    });

    beforeEach(() => {
        // Clear in-memory store between tests
        for (const key of Object.keys(mockStore)) {
            delete mockStore[key];
        }
    });

    // =========================================================================
    // addCustomCommand
    // =========================================================================
    describe('addCustomCommand', () => {
        test('creates a new command and returns true', async () => {
            const result = await addCustomCommand('TestChannel', 'hello', 'Hello $(user)!', 'ModUser');
            expect(result).toBe(true);
            // Verify stored data
            const stored = mockStore['customCommands/testchannel/commands/hello'];
            expect(stored.exists).toBe(true);
            expect(stored.data.response).toBe('Hello $(user)!');
            expect(stored.data.permission).toBe('everyone');
            expect(stored.data.cooldownMs).toBe(0);
            expect(stored.data.useCount).toBe(0);
            expect(stored.data.createdBy).toBe('moduser');
        });

        test('returns false if command already exists', async () => {
            // Pre-populate
            mockStore['customCommands/testchannel/commands/hello'] = {
                exists: true,
                data: { response: 'existing' },
            };

            const result = await addCustomCommand('testchannel', 'hello', 'new response', 'moduser');
            expect(result).toBe(false);
        });

        test('normalizes channel and command names to lowercase', async () => {
            await addCustomCommand('TestChannel', 'MyCmd', 'response', 'SomeUser');
            expect(mockStore['customCommands/testchannel/commands/mycmd']).toBeDefined();
            expect(mockStore['customCommands/testchannel/commands/mycmd'].data.createdBy).toBe('someuser');
        });
    });

    // =========================================================================
    // getCustomCommand
    // =========================================================================
    describe('getCustomCommand', () => {
        test('returns command data when found', async () => {
            mockStore['customCommands/testchannel/commands/greet'] = {
                exists: true,
                data: { response: 'Hi $(user)!', permission: 'everyone' },
            };

            const result = await getCustomCommand('testchannel', 'greet');
            expect(result).toEqual({
                name: 'greet',
                response: 'Hi $(user)!',
                permission: 'everyone',
            });
        });

        test('returns null when command not found', async () => {
            const result = await getCustomCommand('testchannel', 'nonexistent');
            expect(result).toBeNull();
        });
    });

    // =========================================================================
    // getAllCustomCommands
    // =========================================================================
    describe('getAllCustomCommands', () => {
        test('returns all commands for a channel', async () => {
            mockStore['customCommands/testchannel/commands/cmd1'] = {
                exists: true,
                data: { response: 'response1' },
            };
            mockStore['customCommands/testchannel/commands/cmd2'] = {
                exists: true,
                data: { response: 'response2' },
            };

            const result = await getAllCustomCommands('testchannel');
            expect(result).toHaveLength(2);
            expect(result.map(c => c.name)).toEqual(expect.arrayContaining(['cmd1', 'cmd2']));
        });

        test('returns empty array when no commands exist', async () => {
            const result = await getAllCustomCommands('emptychannel');
            expect(result).toEqual([]);
        });
    });

    // =========================================================================
    // removeCustomCommand
    // =========================================================================
    describe('removeCustomCommand', () => {
        test('removes existing command and returns true', async () => {
            mockStore['customCommands/testchannel/commands/bye'] = {
                exists: true,
                data: { response: 'Goodbye!' },
            };

            const result = await removeCustomCommand('testchannel', 'bye');
            expect(result).toBe(true);
            expect(mockStore['customCommands/testchannel/commands/bye']).toBeUndefined();
        });

        test('returns false when command does not exist', async () => {
            const result = await removeCustomCommand('testchannel', 'nonexistent');
            expect(result).toBe(false);
        });
    });

    // =========================================================================
    // incrementUseCount
    // =========================================================================
    describe('incrementUseCount', () => {
        test('increments use count and returns new value', async () => {
            mockStore['customCommands/testchannel/commands/counter'] = {
                exists: true,
                data: { response: 'Used $(count) times', useCount: 5 },
            };

            const newCount = await incrementUseCount('testchannel', 'counter');
            expect(newCount).toBe(6);
        });

        test('returns 0 on error (non-fatal)', async () => {
            // No document exists — update will throw
            const newCount = await incrementUseCount('testchannel', 'nonexistent');
            expect(newCount).toBe(0);
        });
    });
});
