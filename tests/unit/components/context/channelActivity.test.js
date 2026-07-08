// tests/unit/components/context/channelActivity.test.js
import {
    recordChatMessage,
    getLastMessageAt,
    getMessageCount,
    seedLastMessageAt,
    _reset,
} from '../../../../src/components/context/channelActivity.js';

describe('channelActivity', () => {
    beforeEach(() => {
        _reset();
    });

    test('returns zeros for unseen channels', () => {
        expect(getLastMessageAt('nobody')).toBe(0);
        expect(getMessageCount('nobody')).toBe(0);
    });

    test('recordChatMessage increments the message count monotonically', () => {
        recordChatMessage('chan', 1000);
        recordChatMessage('chan', 2000);
        recordChatMessage('chan', 3000);
        expect(getMessageCount('chan')).toBe(3);
    });

    test('lastMessageAt keeps the max timestamp even for out-of-order messages', () => {
        recordChatMessage('chan', 5000);
        recordChatMessage('chan', 2000); // late-arriving older message
        expect(getLastMessageAt('chan')).toBe(5000);
        expect(getMessageCount('chan')).toBe(2); // still counted
    });

    test('recordChatMessage defaults to now when no timestamp given', () => {
        const before = Date.now();
        recordChatMessage('chan');
        expect(getLastMessageAt('chan')).toBeGreaterThanOrEqual(before);
    });

    test('seedLastMessageAt sets the timestamp without affecting the count', () => {
        seedLastMessageAt('chan', 12345);
        expect(getLastMessageAt('chan')).toBe(12345);
        expect(getMessageCount('chan')).toBe(0);
    });

    test('seedLastMessageAt never moves the timestamp backwards', () => {
        recordChatMessage('chan', 9000);
        seedLastMessageAt('chan', 100);
        expect(getLastMessageAt('chan')).toBe(9000);
    });

    test('channels are tracked independently and case-insensitively', () => {
        recordChatMessage('ChanA', 1000);
        recordChatMessage('chana', 2000);
        recordChatMessage('chanb', 3000);
        expect(getMessageCount('chana')).toBe(2);
        expect(getMessageCount('chanb')).toBe(1);
        expect(getLastMessageAt('chana')).toBe(2000);
    });
});
