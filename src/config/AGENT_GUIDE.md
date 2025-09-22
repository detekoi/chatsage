# AI Agent Guide: `/src/config` Directory

## 1. Overview

This directory is responsible for managing the entire application's configuration. It loads settings from a `.env` file or environment variables, validates them, and provides a single, consistent access point for the rest of the application.

- **`loader.js`**: This is the core configuration module. It reads all environment variables, applies default values, validates that required variables are present, and handles any necessary parsing (e.g., converting strings to numbers or arrays).
- **`index.js`**: This file acts as a simple barrel file. It imports the complete configuration object from `loader.js` and re-exports it. This design ensures that all other parts of the application import the configuration from a single, canonical location, which prevents direct and unvalidated access to environment variables.

---

## 2. Making Code Changes

### Adding a New Configuration Variable:

1.  Add the new variable and any necessary validation logic to `loader.js`. You should define a default value or add it to the `requiredEnvVars` array if it's mandatory.
2.  Update the `config` object in `loader.js` to include the new variable.
3.  If the variable is new, update the `.env.example` file to reflect it, providing a brief description of its purpose.
4.  No changes are needed in `index.js`, as it automatically exports the updated config object.

### Best Practices:

-   All modules that need to access configuration settings must do so by importing from `src/config/index.js`. Do not read from `process.env` directly in other parts of the codebase.
-   The `loader.js` module is the single source of truth for all configuration logic. Any changes to how a variable is loaded, parsed, or validated must be made there.
-   When adding or changing a variable in `loader.js`, also consider if it should be included in the `requiredEnvVars` array to ensure a fatal error occurs on startup if it's missing.

---