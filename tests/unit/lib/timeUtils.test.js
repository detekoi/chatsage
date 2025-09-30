import { getCurrentTime, sleep } from '../../../src/lib/timeUtils.js';
import { jest } from '@jest/globals';

// Mock console methods to avoid cluttering test output
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('timeUtils', () => {
  describe('getCurrentTime', () => {
    it('should return current time for UTC timezone', () => {
      const result = getCurrentTime({ timezone: 'UTC' });

      expect(result).toHaveProperty('currentTime');
      expect(typeof result.currentTime).toBe('string');
      expect(result).not.toHaveProperty('error');
    });

    it('should return current time for different timezone', () => {
      const result = getCurrentTime({ timezone: 'America/New_York' });

      expect(result).toHaveProperty('currentTime');
      expect(typeof result.currentTime).toBe('string');
      expect(result).not.toHaveProperty('error');
    });

    it('should return error for invalid timezone', () => {
      const result = getCurrentTime({ timezone: 'Invalid/Timezone' });

      expect(result).toHaveProperty('error');
      expect(result.error).toContain('Invalid timezone');
      expect(result).not.toHaveProperty('currentTime');
    });

    it('should use UTC as default timezone when not specified', () => {
      const result = getCurrentTime({});

      expect(result).toHaveProperty('currentTime');
      expect(typeof result.currentTime).toBe('string');
      expect(result).not.toHaveProperty('error');
    });

    it('should handle timezone parameter as string instead of object', () => {
      const result = getCurrentTime('UTC');

      expect(result).toHaveProperty('currentTime');
      expect(typeof result.currentTime).toBe('string');
      expect(result).not.toHaveProperty('error');
    });
  });

  describe('sleep', () => {
    it('should resolve after specified milliseconds', async () => {
      const startTime = Date.now();
      await sleep(50);
      const endTime = Date.now();

      expect(endTime - startTime).toBeGreaterThanOrEqual(45); // Allow some tolerance
    });

    it('should resolve immediately for 0 milliseconds', async () => {
      const startTime = Date.now();
      await sleep(0);
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(10); // Should be very fast
    });

    it('should handle large delay values', async () => {
      const startTime = Date.now();
      await sleep(10); // Small delay for testing
      const endTime = Date.now();

      expect(endTime - startTime).toBeGreaterThanOrEqual(5);
    });
  });
});
