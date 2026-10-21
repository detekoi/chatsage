// tests/unit/components/context/channelCommandsStorage.test.js
import { getCommandOptions } from '../../../../src/components/context/channelCommandsStorage.js';
import { getFirestore } from '../../../../src/lib/firestore.js';
import logger from '../../../../src/lib/logger.js';

jest.mock('../../../../src/lib/logger.js', () => ({
    __esModule: true,
    default: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

jest.mock('../../../../src/lib/firestore.js', () => ({
    getFirestore: jest.fn(),
    FieldValue: { arrayUnion: jest.fn(), arrayRemove: jest.fn() },
}));

// Channel documents are keyed by broadcaster ID, resolved through the allow-list.
jest.mock('../../../../src/lib/allowList.js', () => ({
    getBroadcasterIdForChannel: jest.fn((name) => ({ testchannel: '4242' })[String(name).toLowerCase()] || null),
    getChannelNameForBroadcasterId: jest.fn((id) => ({ 4242: 'testchannel' })[id] || null),
}));

describe('getCommandOptions', () => {
    let get;
    let doc;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    const mockDoc = (snap) => {
        get = jest.fn().mockResolvedValue(snap);
        doc = jest.fn(() => ({ get }));
        getFirestore.mockReturnValue({ collection: jest.fn(() => ({ doc })) });
    };

    test('returns the options stored for the command, read from the broadcaster ID document', async () => {
        mockDoc({ exists: true, data: () => ({ commandOptions: { so: { aiMessage: false } } }) });

        await expect(getCommandOptions('testchannel', 'so')).resolves.toEqual({ aiMessage: false });
        expect(doc).toHaveBeenCalledWith('4242');
    });

    test.each([
        ['no document', { exists: false, data: () => undefined }],
        ['no options', { exists: true, data: () => ({ disabledCommands: ['so'] }) }],
        ['options that are not an object', { exists: true, data: () => ({ commandOptions: { so: 'on' } }) }],
    ])('returns {} for %s', async (_label, snap) => {
        mockDoc(snap);

        await expect(getCommandOptions('testchannel', 'so')).resolves.toEqual({});
    });

    test('logs at warn and returns {} when Firestore fails', async () => {
        get = jest.fn().mockRejectedValue(new Error('unavailable'));
        getFirestore.mockReturnValue({ collection: jest.fn(() => ({ doc: jest.fn(() => ({ get })) })) });

        await expect(getCommandOptions('testchannel', 'so')).resolves.toEqual({});
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.error).not.toHaveBeenCalled();
    });
});
