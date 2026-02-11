// tests/unit/customCommands/variableParser.test.js
import { parseVariables, formatDuration, formatFollowAge } from '../../../src/components/customCommands/variableParser.js';

// Mock the logger
jest.mock('../../../src/lib/logger.js', () => ({
    __esModule: true,
    default: {
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
        error: jest.fn(),
    },
}));

describe('variableParser', () => {

    // =========================================================================
    // parseVariables
    // =========================================================================
    describe('parseVariables', () => {
        const baseContext = {
            user: 'TestUser',
            channel: 'testchannel',
            args: ['arg1', 'arg2', 'arg3'],
            useCount: 42,
            streamContext: null,
            getFollowage: null,
        };

        // --- Edge cases ---
        test('returns empty string for null template', async () => {
            expect(await parseVariables(null, baseContext)).toBe('');
        });

        test('returns empty string for empty template', async () => {
            expect(await parseVariables('', baseContext)).toBe('');
        });

        test('returns template as-is when no variables present', async () => {
            expect(await parseVariables('Hello world!', baseContext)).toBe('Hello world!');
        });

        // --- $(user) ---
        test('resolves $(user) to display name', async () => {
            const result = await parseVariables('Hello $(user)!', baseContext);
            expect(result).toBe('Hello TestUser!');
        });

        test('resolves $(user) to "unknown" when user is empty', async () => {
            const result = await parseVariables('Hello $(user)!', { ...baseContext, user: '' });
            expect(result).toBe('Hello unknown!');
        });

        test('$(user) is case-insensitive', async () => {
            const result = await parseVariables('$(User) $(USER) $(user)', baseContext);
            expect(result).toBe('TestUser TestUser TestUser');
        });

        // --- $(channel) ---
        test('resolves $(channel) to channel name', async () => {
            const result = await parseVariables('Welcome to $(channel)!', baseContext);
            expect(result).toBe('Welcome to testchannel!');
        });

        test('resolves $(channel) to "unknown" when channel is empty', async () => {
            const result = await parseVariables('$(channel)', { ...baseContext, channel: '' });
            expect(result).toBe('unknown');
        });

        // --- $(args) ---
        test('resolves $(args) to all arguments joined', async () => {
            const result = await parseVariables('You said: $(args)', baseContext);
            expect(result).toBe('You said: arg1 arg2 arg3');
        });

        test('resolves $(args) to empty string when no args', async () => {
            const result = await parseVariables('$(args)', { ...baseContext, args: [] });
            expect(result).toBe('');
        });

        // --- $(1), $(2), etc. ---
        test('resolves positional args $(1), $(2), $(3)', async () => {
            const result = await parseVariables('$(1) - $(2) - $(3)', baseContext);
            expect(result).toBe('arg1 - arg2 - arg3');
        });

        test('resolves out-of-bounds positional arg to empty string', async () => {
            const result = await parseVariables('$(4)', baseContext);
            expect(result).toBe('');
        });

        test('resolves $(1) to empty when no args provided', async () => {
            const result = await parseVariables('$(1)', { ...baseContext, args: [] });
            expect(result).toBe('');
        });

        // --- $(count) ---
        test('resolves $(count) to use count', async () => {
            const result = await parseVariables('Used $(count) times', baseContext);
            expect(result).toBe('Used 42 times');
        });

        test('resolves $(count) to "0" when count is 0', async () => {
            const result = await parseVariables('$(count)', { ...baseContext, useCount: 0 });
            expect(result).toBe('0');
        });

        // --- $(random X-Y) ---
        test('resolves $(random 1-10) to a number in range', async () => {
            const result = await parseVariables('$(random 1-10)', baseContext);
            const num = parseInt(result, 10);
            expect(num).toBeGreaterThanOrEqual(1);
            expect(num).toBeLessThanOrEqual(10);
        });

        test('resolves $(random 5-5) to exactly 5', async () => {
            const result = await parseVariables('$(random 5-5)', baseContext);
            expect(result).toBe('5');
        });

        test('resolves $(random 10-1) (min > max) to min as fallback', async () => {
            const result = await parseVariables('$(random 10-1)', baseContext);
            expect(result).toBe('10');
        });

        test('$(random) is case-insensitive', async () => {
            const result = await parseVariables('$(Random 1-1)', baseContext);
            expect(result).toBe('1');
        });

        // --- $(uptime) ---
        test('resolves $(uptime) to "offline" when no stream context', async () => {
            const result = await parseVariables('$(uptime)', baseContext);
            expect(result).toBe('offline');
        });

        test('resolves $(uptime) to formatted duration when live', async () => {
            const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000 - 30 * 60 * 1000).toISOString();
            const ctx = { ...baseContext, streamContext: { startedAt: twoHoursAgo } };
            const result = await parseVariables('$(uptime)', ctx);
            expect(result).toMatch(/2h 30m/);
        });

        test('resolves $(uptime) to "offline" when startedAt is invalid', async () => {
            const ctx = { ...baseContext, streamContext: { startedAt: 'not-a-date' } };
            const result = await parseVariables('$(uptime)', ctx);
            expect(result).toBe('offline');
        });

        // --- $(game) ---
        test('resolves $(game) to current game', async () => {
            const ctx = { ...baseContext, streamContext: { game: 'Minecraft' } };
            const result = await parseVariables('Playing $(game)', ctx);
            expect(result).toBe('Playing Minecraft');
        });

        test('resolves $(game) to "Unknown" when no stream context', async () => {
            const result = await parseVariables('$(game)', baseContext);
            expect(result).toBe('Unknown');
        });

        test('resolves $(game) to "Unknown" when game is "N/A"', async () => {
            const ctx = { ...baseContext, streamContext: { game: 'N/A' } };
            const result = await parseVariables('$(game)', ctx);
            expect(result).toBe('Unknown');
        });

        // --- $(followage) ---
        test('resolves $(followage) via async getFollowage function', async () => {
            const getFollowage = jest.fn().mockResolvedValue('2 years 3 months');
            const ctx = { ...baseContext, getFollowage };
            const result = await parseVariables('$(followage)', ctx);
            expect(result).toBe('2 years 3 months');
            expect(getFollowage).toHaveBeenCalledWith('TestUser', 'testchannel');
        });

        test('resolves $(followage) to "unable to check followage" on error', async () => {
            const getFollowage = jest.fn().mockRejectedValue(new Error('API error'));
            const ctx = { ...baseContext, getFollowage };
            const result = await parseVariables('$(followage)', ctx);
            expect(result).toBe('unable to check followage');
        });

        test('resolves $(followage) to "followage unavailable" when no function provided', async () => {
            const result = await parseVariables('$(followage)', baseContext);
            expect(result).toBe('followage unavailable');
        });

        // --- Unknown variables ---
        test('returns unknown variables as-is', async () => {
            const result = await parseVariables('$(foo)', baseContext);
            expect(result).toBe('$(foo)');
        });

        // --- Multiple variables ---
        test('resolves multiple variables in one template', async () => {
            const result = await parseVariables(
                '$(user) in $(channel) said $(args) (used $(count) times)',
                baseContext,
            );
            expect(result).toBe('TestUser in testchannel said arg1 arg2 arg3 (used 42 times)');
        });

        test('resolves duplicate variables', async () => {
            const result = await parseVariables('$(user) and $(user)', baseContext);
            expect(result).toBe('TestUser and TestUser');
        });
    });

    // =========================================================================
    // formatDuration
    // =========================================================================
    describe('formatDuration', () => {
        test('formats 0ms as "0m"', () => {
            expect(formatDuration(0)).toBe('0m');
        });

        test('formats negative ms as "0m"', () => {
            expect(formatDuration(-1000)).toBe('0m');
        });

        test('formats minutes only', () => {
            expect(formatDuration(15 * 60 * 1000)).toBe('15m');
        });

        test('formats hours and minutes', () => {
            expect(formatDuration(2 * 60 * 60 * 1000 + 30 * 60 * 1000)).toBe('2h 30m');
        });

        test('formats days, hours, and minutes', () => {
            expect(formatDuration(1 * 86400 * 1000 + 5 * 3600 * 1000 + 10 * 60 * 1000)).toBe('1d 5h 10m');
        });

        test('formats exact hours (no minutes shown)', () => {
            expect(formatDuration(3 * 60 * 60 * 1000)).toBe('3h');
        });

        test('formats exact days (no hours/minutes shown)', () => {
            expect(formatDuration(2 * 86400 * 1000)).toBe('2d');
        });
    });

    // =========================================================================
    // formatFollowAge
    // =========================================================================
    describe('formatFollowAge', () => {
        test('returns "unknown" for invalid date', () => {
            expect(formatFollowAge('not-a-date')).toBe('unknown');
        });

        test('returns "just now" for current time', () => {
            const now = new Date().toISOString();
            expect(formatFollowAge(now)).toBe('just now');
        });

        test('formats days correctly (within same month)', () => {
            const daysAgo = new Date();
            daysAgo.setDate(daysAgo.getDate() - 15);
            const result = formatFollowAge(daysAgo.toISOString());
            expect(result).toMatch(/15 days/);
        });

        test('formats months correctly', () => {
            const monthsAgo = new Date();
            monthsAgo.setMonth(monthsAgo.getMonth() - 6);
            const result = formatFollowAge(monthsAgo.toISOString());
            expect(result).toMatch(/6 months/);
        });

        test('formats years correctly', () => {
            const yearsAgo = new Date();
            yearsAgo.setFullYear(yearsAgo.getFullYear() - 2);
            const result = formatFollowAge(yearsAgo.toISOString());
            expect(result).toMatch(/2 years/);
        });

        test('hides days when over a year', () => {
            const longAgo = new Date();
            longAgo.setFullYear(longAgo.getFullYear() - 1);
            longAgo.setDate(longAgo.getDate() - 10);
            const result = formatFollowAge(longAgo.toISOString());
            expect(result).not.toMatch(/day/);
        });

        test('uses singular for 1 year/month/day', () => {
            const oneYearAgo = new Date();
            oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
            oneYearAgo.setMonth(oneYearAgo.getMonth() - 1);
            const result = formatFollowAge(oneYearAgo.toISOString());
            expect(result).toMatch(/1 year/);
            expect(result).toMatch(/1 month/);
            expect(result).not.toMatch(/years/);
            expect(result).not.toMatch(/months/);
        });
    });
});
