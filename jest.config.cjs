// jest.config.cjs
module.exports = {
  testEnvironment: 'node',
  // setupFiles runs before the test framework is installed, so env vars are in place
  // before a test file's top-level imports evaluate src/config/loader.js. This must not
  // be moved into setupFilesAfterEnv — that runs too late to help.
  setupFiles: ['<rootDir>/tests/env.setup.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/jest.setup.js'],
  // The transform property is needed if you are using ES modules or TypeScript
  transform: {
    '^.+\\.js$': 'babel-jest',
  },
};

