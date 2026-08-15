// tests/unit/lib/allowList.test.js

import {
    isChannelAllowed,
    isChannelActive,
    updateAllowedChannels,
    addAllowedChannel,
    setChannelActive,
    removeAllowedChannel,
} from '../../../src/lib/allowList.js';

describe('allowList (Firestore-backed cache)', () => {
    beforeEach(() => {
        updateAllowedChannels([]);
    });

    describe('fail-closed contract', () => {
        it('denies everything when no channels are loaded', () => {
            expect(isChannelAllowed('anything')).toBe(false);
            expect(isChannelActive('anything')).toBe(false);
        });

        it('returns false for null/undefined/empty identifier', () => {
            expect(isChannelAllowed(null)).toBe(false);
            expect(isChannelAllowed(undefined)).toBe(false);
            expect(isChannelAllowed('')).toBe(false);
            expect(isChannelActive(null)).toBe(false);
        });
    });

    describe('isChannelAllowed', () => {
        it('matches on broadcaster ID and on login name, case-insensitively', () => {
            updateAllowedChannels([
                { name: 'alice', twitchUserId: '12345' },
                { name: 'bob', twitchUserId: '67890' },
            ]);
            expect(isChannelAllowed('12345')).toBe(true);
            expect(isChannelAllowed('alice')).toBe(true);
            expect(isChannelAllowed('Alice')).toBe(true);
            expect(isChannelAllowed('67890')).toBe(true);
        });

        it('returns false for an unknown ID or name', () => {
            updateAllowedChannels([
                { name: 'alice', twitchUserId: '12345' },
            ]);
            expect(isChannelAllowed('99999')).toBe(false);
            expect(isChannelAllowed('unknownchannel')).toBe(false);
        });
    });

    describe('approved vs active', () => {
        it('keeps an inactive channel on the allow-list', () => {
            updateAllowedChannels([
                { name: 'alice', twitchUserId: '12345', isActive: false },
            ]);
            expect(isChannelAllowed('12345')).toBe(true);
            expect(isChannelAllowed('alice')).toBe(true);
            expect(isChannelActive('12345')).toBe(false);
            expect(isChannelActive('alice')).toBe(false);
        });

        it('reports an active channel as both allowed and active', () => {
            updateAllowedChannels([
                { name: 'alice', twitchUserId: '12345', isActive: true },
            ]);
            expect(isChannelAllowed('12345')).toBe(true);
            expect(isChannelActive('12345')).toBe(true);
        });

        it('treats an omitted isActive as active (pre-split callers)', () => {
            updateAllowedChannels([
                { name: 'alice', twitchUserId: '12345' },
            ]);
            expect(isChannelActive('12345')).toBe(true);
        });

        it('indexes channels without a twitchUserId by login name', () => {
            updateAllowedChannels([
                { name: 'noId', twitchUserId: null, isActive: true },
            ]);
            expect(isChannelAllowed('noid')).toBe(true);
            expect(isChannelActive('noId')).toBe(true);
        });
    });

    describe('updateAllowedChannels', () => {
        it('replaces the entire cache', () => {
            updateAllowedChannels([{ name: 'alice', twitchUserId: '111' }]);
            expect(isChannelAllowed('111')).toBe(true);

            updateAllowedChannels([{ name: 'bob', twitchUserId: '222' }]);
            expect(isChannelAllowed('111')).toBe(false);
            expect(isChannelAllowed('alice')).toBe(false);
            expect(isChannelAllowed('222')).toBe(true);
        });
    });

    describe('addAllowedChannel', () => {
        it('approves a channel without switching the bot on', () => {
            addAllowedChannel('newchannel', '222');
            expect(isChannelAllowed('222')).toBe(true);
            expect(isChannelAllowed('newchannel')).toBe(true);
            expect(isChannelActive('222')).toBe(false);
        });

        it('handles null inputs gracefully', () => {
            addAllowedChannel(null, '42');
            addAllowedChannel('test', null);
            // Should not throw
        });
    });

    describe('setChannelActive', () => {
        it('switches a channel on and off without revoking approval', () => {
            updateAllowedChannels([
                { name: 'alice', twitchUserId: '111', isActive: true },
            ]);

            setChannelActive('alice', '111', false);
            expect(isChannelActive('111')).toBe(false);
            expect(isChannelAllowed('111')).toBe(true);
            expect(isChannelAllowed('alice')).toBe(true);

            setChannelActive('alice', '111', true);
            expect(isChannelActive('111')).toBe(true);
        });

        it('approves an unknown channel it is asked to activate (dev-mode boot)', () => {
            setChannelActive('parfaittest', '999', true);
            expect(isChannelAllowed('999')).toBe(true);
            expect(isChannelActive('parfaittest')).toBe(true);
        });
    });

    describe('removeAllowedChannel', () => {
        it('removes a channel from every cache', () => {
            updateAllowedChannels([
                { name: 'alice', twitchUserId: '111' },
                { name: 'bob', twitchUserId: '222' },
            ]);
            removeAllowedChannel('alice', '111');
            expect(isChannelAllowed('111')).toBe(false);
            expect(isChannelAllowed('alice')).toBe(false);
            expect(isChannelActive('111')).toBe(false);
            expect(isChannelAllowed('222')).toBe(true);
        });

        it('removes the mapped login name when given only an ID', () => {
            updateAllowedChannels([{ name: 'alice', twitchUserId: '111' }]);
            removeAllowedChannel(null, '111');
            expect(isChannelAllowed('alice')).toBe(false);
            expect(isChannelAllowed('111')).toBe(false);
        });
    });
});
