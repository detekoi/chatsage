# Testing Conventions

To prevent tests from hanging and ensure a stable CI environment, this project follows a strict set of rules for managing asynchronous operations and side effects.

### 1. No Side-Effects on Import

Modules **must not** start timers, open sockets, connect to databases, or initiate any other background processes at the top level (i.e., when they are imported). This kind of work creates open handles that prevent Jest from exiting cleanly.

**BAD:**
```javascript
// src/components/my-service.js
const interval = setInterval(() => { /* do work */ }, 5000); // Starts on import!
```

**GOOD:**

```javascript
// src/components/my-service.js
let interval;

export function init() {
  if (interval) return;
  interval = setInterval(() => { /* do work */ }, 5000);
  // Unref the timer so it doesn't keep the Node.js process alive on its own.
  // This is crucial for background tasks that can run independently.
  if (interval.unref) {
    interval.unref();
  }
}

export function shutdown() {
  if (interval) {
    clearInterval(interval);
    interval = undefined;
  }
}

// Only auto-start outside of the test environment.
if (process.env.NODE_ENV !== 'test') {
  init();
}
```

### 2. Global Setup and Teardown

The `tests/jest.setup.js` file automatically runs before and after each test suite. It:

  - Uses **real timers** by default (tests can opt into fake timers locally).
  - Clears all mocks before each test and ensures real timers after each test.
  - **Detects open handles** after all tests in a file have run and will fail the suite if any are found.

### 3. Opting Into Fake Timers

If a specific test benefits from fake time control (e.g., advancing timers deterministically), you can opt in within the test file:

```javascript
describe('My fake-time test', () => {
  // Use fake timers for all tests in this describe block
  jest.useFakeTimers();

  it('advances one second deterministically', () => {
    const fn = jest.fn();
    setTimeout(fn, 1000);
    jest.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
```

### 4. Debugging Open Handles

If a test fails due to open handles, you can temporarily debug it by running Jest with `JEST_ALLOW_OPEN_HANDLES=1`:

```bash
JEST_ALLOW_OPEN_HANDLES=1 npx jest your-test-file.test.js
```

This will bypass the check and allow you to use Jest's `--detectOpenHandles` flag more effectively to pinpoint the source of the leak.
