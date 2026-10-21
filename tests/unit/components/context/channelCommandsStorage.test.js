// tests/unit/components/context/channelCommandsStorage.test.js
import {
    loadAllChannelCommandSettings,
    listenForCommandSettingsChanges,
    ChannelCommandsStorageError,
} from '../../../../src/components/context/channelCommandsStorage.js';
import { getFirestore } from '../../../../src/lib/firestore.js';

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
    getBroadcasterIdForChannel: jest.fn((name) => ({ testchannel: '4242', other: '4343' })[String(name).toLowerCase()] || null),
    getChannelNameForBroadcasterId: jest.fn((id) => ({ 4242: 'testchannel', 4343: 'other' })[id] || null),
}));

const doc = (id, data) => ({ id, data: () => data });

describe('loadAllChannelCommandSettings', () => {
    const mockCollection = (docs) => {
        getFirestore.mockReturnValue({
            collection: jest.fn(() => ({ get: jest.fn().mockResolvedValue({ forEach: (fn) => docs.forEach(fn) }) })),
        });
    };

    test('returns the disabled commands and the command options of each channel', async () => {
        mockCollection([
            doc('4242', { disabledCommands: ['trivia'], commandOptions: { SO: { aiMessage: false } } }),
            doc('4343', { disabledCommands: [] }),
        ]);

        const { disabledCommands, commandOptions } = await loadAllChannelCommandSettings();

        expect(disabledCommands.get('testchannel')).toEqual(new Set(['trivia']));
        expect(disabledCommands.get('other')).toEqual(new Set());
        // Command names are lowercased, so the bot finds them whatever case the dashboard wrote
        expect(commandOptions.get('testchannel')).toEqual({ so: { aiMessage: false } });
        expect(commandOptions.get('other')).toEqual({});
    });

    test.each([
        ['a string', 'on'],
        ['an array', [true]],
        ['null', null],
    ])('drops options that are %s', async (_label, value) => {
        mockCollection([doc('4242', { commandOptions: { so: value } })]);

        const { commandOptions } = await loadAllChannelCommandSettings();

        expect(commandOptions.get('testchannel')).toEqual({});
    });

    test('throws a storage error when Firestore fails', async () => {
        getFirestore.mockReturnValue({
            collection: jest.fn(() => ({ get: jest.fn().mockRejectedValue(new Error('unavailable')) })),
        });

        await expect(loadAllChannelCommandSettings()).rejects.toBeInstanceOf(ChannelCommandsStorageError);
    });
});

describe('listenForCommandSettingsChanges', () => {
    test('passes the disabled commands and the command options to the callback', () => {
        let onSnapshot;
        getFirestore.mockReturnValue({
            collection: jest.fn(() => ({ onSnapshot: jest.fn((next) => { onSnapshot = next; return jest.fn(); }) })),
        });
        const callback = jest.fn();
        listenForCommandSettingsChanges(callback);

        onSnapshot({
            docChanges: () => [
                { type: 'modified', doc: doc('4242', { disabledCommands: ['geo'], commandOptions: { so: { twitchShoutout: false } } }) },
                { type: 'removed', doc: doc('4343', { disabledCommands: ['so'], commandOptions: { so: { aiMessage: false } } }) },
            ],
        });

        expect(callback).toHaveBeenCalledWith('testchannel', new Set(['geo']), { so: { twitchShoutout: false } });
        // A removed document means "everything at its default", not "as before"
        expect(callback).toHaveBeenCalledWith('other', new Set(), {});
    });
});
