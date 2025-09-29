// tests/jest.setup.js

// Use real timers by default for production fidelity. Tests can opt into fake timers locally.
beforeEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

afterEach(() => {
  // Nothing global to flush; tests using fake timers should flush locally.
  jest.useRealTimers();
});

// Safety net: fail fast if handles remain (except when explicitly allowed).
afterAll(() => {
  if (process.env.JEST_ALLOW_OPEN_HANDLES) return;
  // eslint-disable-next-line no-underscore-dangle
  const handles = process._getActiveHandles().filter(h => {
    // ignore TTY/stdio, pipes, sockets, and child processes which are always present in Node.js
    const ignoreTypes = ['Pipe', 'Socket', 'ChildProcess'];
    const constructorName = h.constructor?.name || typeof h;
    return !(h === process.stdin || h === process.stdout || h === process.stderr ||
             ignoreTypes.includes(constructorName));
  });
  if (handles.length) {
    // Log handle types to help with future debugging
    // eslint-disable-next-line no-console
    console.error('OPEN HANDLES:', handles.map(h => h.constructor?.name || typeof h));
    throw new Error(`Found ${handles.length} open handle(s). Close them or call unref() in your code/tests.`);
  }
});

// More aggressive cleanup after each test
afterEach(() => {
  // Clear all timers to prevent hanging
  jest.clearAllTimers();

  // Run pending promises to ensure async operations complete
  return new Promise(resolve => {
    setImmediate(() => {
      resolve();
    });
  });
});
