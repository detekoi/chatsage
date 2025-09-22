# AI Agent Guide: `/src/components/twitch` Directory

## 1. Overview

This directory contains all modules responsible for direct interaction with the Twitch platform, including IRC chat, the Helix API, and EventSub webhooks.

- **`ircClient.js`**: Manages the connection to Twitch's IRC server for sending and receiving chat messages. Handles connection logic, authentication failures, and basic event listening.
- **`ircAuthHelper.js`**: Handles the OAuth flow for getting and refreshing the bot's chat token.
- **`helixClient.js`**: A client for making requests to the Twitch Helix API. It includes interceptors for automatically handling authentication and logging.
- **`auth.js`**: Manages the App Access Token used by the `helixClient`.
- **`streamInfoPoller.js`**: Periodically fetches updated stream information (game, title, etc.) for all connected channels using the `helixClient`.
- **`eventsub.js`**: Handles incoming EventSub webhooks (e.g., `stream.online`, `stream.offline`) to enable serverless, scale-to-zero functionality.
- **`channelManager.js`**: Manages the list of channels the bot should be in by reading from a Firestore collection.

---

## 2. Making Code Changes

### Interacting with Twitch API:

-   **All Helix API calls must go through `helixClient.js`**. Do not make direct `axios` requests to the Twitch API. This ensures that authentication and rate limiting are handled correctly.
-   To add a new API endpoint, create a new function in `helixClient.js` that takes the required parameters and makes the request (e.g., `getUsersByLogin`).

### Modifying Chat Behavior:

-   Low-level IRC connection logic resides in `ircClient.js`. Modifications here should be made with care.
-   The main message handler in `bot.js` receives events from `ircClient.js`. If you need to react to a new type of IRC event, add a listener in `bot.js`.

### EventSub and Webhooks:

-   To handle a new type of EventSub notification, add a new case in the `eventSubHandler` function in `eventsub.js`.
-   The logic for subscribing to new events should be added to `twitchSubs.js`.

---