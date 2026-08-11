# Testing Conventions

This project uses rules for asynchronous operations and side effects. These rules prevent tests from hanging and make sure that the CI environment is stable.

## 1. No Side Effects on Import

Modules must not start timers, open sockets, connect to databases, or start background operations at the module root (when imported). Root operations create open handles that stop Jest from exiting.

**INCORRECT:**

```javascript
// src/components/my-service.js
const interval = setInterval(() => { /* do work */ }, 5000); // Starts on import!
```

**CORRECT:**

```javascript
// src/components/my-service.js
let interval;

export function init() {
  if (interval) return;
  interval = setInterval(() => { /* do work */ }, 5000);
  // Unref the timer so it does not keep the Node.js process alive.
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

// Auto-start only outside the test environment.
if (process.env.NODE_ENV !== 'test') {
  init();
}
```

## 2. Global Setup and Teardown

The setup script `tests/jest.setup.js` runs automatically before and after each test suite:

- It uses real timers by default.
- It clears all mocks before each test.
- It restores real timers after each test.
- It detects open handles after a test file completes. If open handles remain, the test suite fails.

## 3. Opting Into Fake Timers

If a test needs fake timer control, enable fake timers in the test file:

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

## 4. Debugging Open Handles

If a test fails because of open handles, run Jest with `JEST_ALLOW_OPEN_HANDLES=1` to debug the test:

```bash
JEST_ALLOW_OPEN_HANDLES=1 npx jest your-test-file.test.js
```

This variable bypasses the strict handle check so that you can use the `--detectOpenHandles` flag to locate the handle leak.
