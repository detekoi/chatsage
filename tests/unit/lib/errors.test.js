import * as errors from '../../../src/lib/errors.js';

describe('errors', () => {
  it('should export a default object', () => {
    expect(errors).toHaveProperty('default');
    expect(typeof errors.default).toBe('object');
  });

  it('should have no named exports', () => {
    const keys = Object.keys(errors);
    expect(keys).not.toContain('initializeSecretManager');
    expect(keys).not.toContain('getSecretValue');
    expect(keys).not.toContain('setSecretValue');
  });
});
