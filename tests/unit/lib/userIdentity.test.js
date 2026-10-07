// tests/unit/lib/userIdentity.test.js

jest.mock('../../../src/lib/logger.js');
jest.mock('../../../src/components/twitch/helixClient.js', () => ({
    getUsersByLogin: jest.fn(),
}));

import { getUsersByLogin } from '../../../src/components/twitch/helixClient.js';
import {
    noteUser,
    currentLogin,
    resolveUserIds,
    normalizeLogin,
    _clearUserIdentityCache,
} from '../../../src/lib/userIdentity.js';

beforeEach(() => {
    _clearUserIdentityCache();
    getUsersByLogin.mockReset().mockResolvedValue([]);
});

describe('normalizeLogin', () => {
    it('strips @ and lowercases, rejecting words that are not logins', () => {
        expect(normalizeLogin('@SleepySabrinas')).toBe('sleepysabrinas');
        expect(normalizeLogin('a')).toBeNull();
        expect(normalizeLogin('not-a-login')).toBeNull();
        expect(normalizeLogin(undefined)).toBeNull();
    });
});

describe('resolveUserIds', () => {
    it('serves logins seen in chat from cache without calling Helix', async () => {
        noteUser('123', 'SleepySabrinas');
        const ids = await resolveUserIds(['@sleepysabrinas']);
        expect(ids.get('sleepysabrinas')).toBe('123');
        expect(getUsersByLogin).not.toHaveBeenCalled();
    });

    it('batches misses through Helix and caches the result', async () => {
        getUsersByLogin.mockResolvedValue([{ id: '7', login: 'bob' }]);
        const ids = await resolveUserIds(['bob', '@Bob', 'nobody', 'cats and dogs']);
        expect(getUsersByLogin).toHaveBeenCalledTimes(1);
        expect(getUsersByLogin.mock.calls[0][0]).toEqual(['bob', 'nobody']);
        expect([...ids]).toEqual([['bob', '7']]);

        await resolveUserIds(['bob']);
        expect(getUsersByLogin).toHaveBeenCalledTimes(1);
        expect(currentLogin('7')).toBe('bob');
    });

    it('follows renames and hands a released login to its new owner', async () => {
        noteUser('123', 'oldname');
        noteUser('123', 'newname');
        expect(currentLogin('123')).toBe('newname');
        expect((await resolveUserIds(['newname'])).get('newname')).toBe('123');

        noteUser('999', 'oldname');
        expect((await resolveUserIds(['oldname'])).get('oldname')).toBe('999');
    });

    it('never throws when Helix fails', async () => {
        getUsersByLogin.mockRejectedValue(new Error('boom'));
        await expect(resolveUserIds(['bob'])).resolves.toEqual(new Map());
    });
});
