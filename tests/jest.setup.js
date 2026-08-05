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
  const handles = process._getActiveHandles().filter(h => {
    if (!h) return false;
    const isStdio = h === process.stdin || h === process.stdout || h === process.stderr;
    const name = (h.constructor?.name || h.name || '').toLowerCase();
    const ignoreTypes = ['pipe', 'pipewrap', 'socket', 'childprocess', 'ttywrap', 'signalwrap'];
    const isIgnoredType = ignoreTypes.some(t => name.includes(t));
    const isInternalHandle = !h.constructor || ('_handle' in h) || ('fd' in h);
    return !(isStdio || isIgnoredType || isInternalHandle);
  });
  if (handles.length) {
    // Log handle types to help with future debugging
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
