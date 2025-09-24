// jest.config.cjs
module.exports = {
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/tests/jest.setup.js'],
  // The transform property is needed if you are using ES modules or TypeScript
  transform: {
    '^.+\\.js$': 'babel-jest',
  },
};
