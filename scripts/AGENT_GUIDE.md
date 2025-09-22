# AI Agent Guide: `/scripts` Directory

## 1. Overview

This directory contains utility and maintenance scripts that are not part of the main application runtime but are used for development, deployment, and operational tasks.

- **`deploy-cloud-run.sh`**: A shell script to deploy the application to Google Cloud Run, mirroring the CI/CD pipeline.
- **`generate-command-table.js`**: A script that automatically generates an HTML table of all available commands for the documentation website.
- **`manage-eventsub.js`**: A tool for managing Twitch EventSub subscriptions (listing, creating, deleting).
- **`migrate-channels-to-firestore.js`**: A one-time script for migrating the channel list from environment variables to Firestore.
- **`get-app-token.js`**: A utility to fetch a Twitch App Access Token.

---

## 2. Making Code Changes

### Modifying a Script:

-   Identify the script that performs the task you want to change and modify it directly.
-   These scripts are run manually from the command line (e.g., `node scripts/some-script.js`).

### Adding a New Script:

1.  Create a new `.js` or `.sh` file in this directory.
2.  Add a new entry in the `scripts` section of `package.json` to make it easy to run (e.g., `"my-script": "node scripts/my-script.js"`).
3.  Document the script's purpose and usage with comments at the top of the file.

### Best Practices:

-   Scripts should be self-contained and clearly documented.
-   For scripts that interact with Google Cloud or Twitch APIs, ensure they load configuration and initialize clients correctly, similar to how `bot.js` does.
-   Do not add runtime application logic here. This directory is for operational tools only.

---