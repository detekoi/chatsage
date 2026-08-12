// tests/jest.setup.js

// Use real timers by default for production fidelity. Tests can opt into fake timers locally.
beforeEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

afterEach(() => {
  // Tests using fake timers should flush locally; this just restores the default.
  jest.clearAllTimers();
  jest.useRealTimers();

  // Run pending promises to ensure async operations complete.
  return new Promise(resolve => {
    setImmediate(() => {
      resolve();
    });
  });
});

// A previous afterAll hook here tried to fail suites that leaked open handles.
// It could never fire: its filter discarded anything with an `fd` (every real
// socket and server) and timers do not appear in process._getActiveHandles() at
// all, so the survivor count was always zero even while CI reported "worker
// process has failed to exit gracefully". Run `jest --detectOpenHandles` to
// chase a leak instead.
