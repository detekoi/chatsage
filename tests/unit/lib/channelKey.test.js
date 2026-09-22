// tests/unit/lib/channelKey.test.js

jest.mock('../../../src/lib/allowList.js', () => ({
    getBroadcasterIdForChannel: jest.fn((name) => ({ streamer: '4242' })[String(name).toLowerCase()] || null),
    getChannelNameForBroadcasterId: jest.fn((id) => ({ 4242: 'streamer' })[id] || null),
}));

import {
    channelDocKey,
    channelNameForDocKey,
    isBroadcasterIdKey,
    normalizeChannelName,
    UnresolvedChannelError,
} from '../../../src/lib/channelKey.js';

describe('channelDocKey', () => {
    it('resolves a login to its broadcaster ID, ignoring case and a leading #', () => {
        expect(channelDocKey('streamer')).toBe('4242');
        expect(channelDocKey('#Streamer')).toBe('4242');
    });

    it('throws rather than falling back to the login for an unknown channel', () => {
        expect(() => channelDocKey('nobody')).toThrow(UnresolvedChannelError);
        expect(() => channelDocKey('')).toThrow(UnresolvedChannelError);
    });
});

describe('channelNameForDocKey', () => {
    it('prefers the allow-list mapping, which follows renames', () => {
        expect(channelNameForDocKey('4242', { channelName: 'old_name' })).toBe('streamer');
    });

    it('falls back to the stored channelName for a channel no longer managed', () => {
        expect(channelNameForDocKey('9999', { channelName: 'Gone' })).toBe('gone');
    });

    it('returns null when nothing identifies the channel', () => {
        expect(channelNameForDocKey('9999')).toBeNull();
        expect(channelNameForDocKey('9999', {})).toBeNull();
    });

    it('never resolves a legacy login-keyed document, even one carrying channelName', () => {
        expect(channelNameForDocKey('streamer', { channelName: 'streamer' })).toBeNull();
    });
});

describe('helpers', () => {
    it('recognizes numeric IDs as broadcaster keys and logins as legacy keys', () => {
        expect(isBroadcasterIdKey('4242')).toBe(true);
        expect(isBroadcasterIdKey('streamer')).toBe(false);
        expect(isBroadcasterIdKey('_x1')).toBe(false);
    });

    it('normalizes channel names', () => {
        expect(normalizeChannelName(' #Streamer ')).toBe('streamer');
        expect(normalizeChannelName(null)).toBe('');
    });
});
