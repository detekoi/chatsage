# AI Agent Guide: `/tests` Directory

## 1. Overview

This directory contains all the tests for the application, divided into `unit` and `integration` tests. The structure of the `tests/` directory mirrors the `src/` directory.

- **`fixtures/`**: Contains mock data, such as sample API responses, used to make tests predictable.
- **`integration/`**: Contains tests that verify the interaction between multiple components of the application.
- **`unit/`**: Contains tests that isolate and verify the functionality of individual modules or functions.

---

## 2. Making Code Changes

### Adding New Tests:

-   When you add a new feature or function in `src/`, you should add a corresponding test file in `tests/unit/`. For example, a new function in `src/lib/utils.js` should have tests in `tests/unit/lib/utils.test.js`.
-   Use Jest as the testing framework. All test files should end with `.test.js`.
-   **Mock all external dependencies**. This is critical. Use `jest.mock()` to mock API clients (like `axios` or `@google/genai`), libraries that connect to external services (like `tmi.js`), and even your own modules that are not the subject of the current test. This ensures tests are fast, reliable, and don't make real network calls.

### Writing Effective Tests:

-   **Arrange, Act, Assert**: Structure your tests clearly. First, set up the conditions and mocks. Second, call the function you are testing. Third, assert that the outcome is what you expected.
-   **Test Edge Cases**: Test how your code handles invalid input, empty arrays, errors from dependencies, etc.
-   Refer to existing tests (e.g., `helixClient.test.js`) for examples of how to mock modules and structure tests.
-   Run tests locally with `npm test`.

---