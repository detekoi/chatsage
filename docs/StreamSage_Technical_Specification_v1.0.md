# StreamSage Technical Specification (Version 1.0)

**Document Revision History**

| Version | Description            | Date           |
| :------ | :--------------------- | :------------- |
| 1.0     | Initial Specification | [Current Date] |

# 1. Introduction

## 1.1 Purpose

This document outlines the technical specifications for the StreamSage, an AI-powered chatbot designed to operate within Twitch chat environments. The primary goal of StreamSage is to provide contextually relevant, informative, and engaging responses based on chat history, user queries, and the real-time context of the live Twitch stream it is operating in. This includes awareness of the current game being played, the stream title, and associated tags.

## 1.2 Scope

This specification covers the core architecture, components, data flow, configuration, external API interactions (including Twitch Helix API integration for stream context), context management strategies, LLM prompting, error handling, security considerations, and dependencies of the StreamSage.

## 1.3 Definitions and Acronyms

| Term/Acronym           | Definition                                                                                                                                            |
| :--------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AI`                   | Artificial Intelligence                                                                                                                               |
| `API`                  | Application Programming Interface                                                                                                                     |
| `Bot`                  | An automated software application that performs tasks over the internet.                                                                              |
| `Client ID`            | A unique identifier assigned to an application registered with Twitch. Required for API authentication.                                                 |
| `Context`              | Information used by the LLM to generate relevant responses, including chat history, chat summaries, and stream information.                           |
| `Helix`                | The current version of the Twitch RESTful API, used for accessing Twitch data and performing actions.                                                    |
| `HTTP`                 | Hypertext Transfer Protocol                                                                                                                           |
| `IRC`                  | Internet Relay Chat; the protocol used for Twitch chat.                                                                                               |
| `JSON`                 | JavaScript Object Notation; a standard text-based format for representing structured data.                                                            |
| `JWT`                  | JSON Web Token; a standard for securely transmitting information between parties as a JSON object.                                                     |
| `LLM`                  | Large Language Model; the AI model responsible for understanding context and generating responses (e.g., Google Gemini).                                |
| `OAuth`                | Open Authorization; a standard protocol for access delegation, used by Twitch for API authentication.                                                   |
| `Rate Limit`           | A restriction imposed by an API on the number of requests a client can make within a specific time period.                                              |
| `Scope`                | Defines the specific permissions granted by a user to an application via OAuth.                                                                         |
| `SDK`                  | Software Development Kit                                                                                                                              |
| `tmi.js`               | A Node.js library for interacting with Twitch chat via IRC.                                                                                           |
| `@google/generative-ai`        | The Node.js SDK for interacting with the Google Gemini API.                                                                                            |

# 2. Core Architecture

## 2.1 Overview

StreamSage employs a modular architecture designed for real-time interaction and contextual awareness within Twitch channels. It leverages external services for chat connectivity (Twitch IRC), advanced language understanding (Google Gemini LLM), and real-time stream data retrieval (Twitch Helix API).

The core components interact as follows: The Twitch IRC Interface connects to Twitch chat, receiving messages and sending bot responses. Incoming messages are passed to the Context Manager and potentially the Command Processor. To generate intelligent responses, the Context Manager gathers relevant chat history, summaries, and current stream information (fetched periodically by the Twitch Helix API Interface). This consolidated context is provided to the LLM Interaction component, which formats it into a prompt and sends it to the Gemini API via the `@google/generative-ai` SDK. The LLM's response is returned, potentially processed further, and sent back to the chat via the Twitch IRC Interface. Configuration settings are managed by the Configuration Manager, and all significant events and errors are logged by the Logger.

(An architectural diagram should be included here, illustrating the Twitch IRC Interface, Twitch Helix API Interface, Context Manager, LLM Interaction, Command Processor, Configuration Manager, Logger, and their interactions with external Twitch IRC, Twitch Helix API, and Google Gemini API services).

The integration of the Helix API introduces a primary data source alongside the IRC chat stream. This necessitates careful management of potentially distinct authentication credentials, rate limits, and error conditions associated with HTTP API interactions, separate from the existing IRC connection handling. Failure to retrieve timely stream context from Helix could lead to the LLM operating with incomplete or stale information, impacting response quality even if the chat connection remains active. This potential desynchronization between the real-time chat flow and the periodically updated stream state awareness must be considered in the bot's operational logic and error handling.

## 2.2 Components

*   **Twitch IRC Interface (`tmi.js`):**
    *   Responsibilities: Establishes and maintains connection to Twitch IRC servers for specified channels; receives real-time chat messages, JOIN/PART events (if enabled), and other IRC messages; sends formatted messages from the bot to Twitch chat; handles IRC-level PING/PONG and reconnection logic.
    *   Technology: `tmi.js` Node.js library.
*   **Twitch Helix API Interface:**
    *   Responsibilities: Manages authenticated communication with the Twitch Helix REST API; periodically fetches current stream information (game, title, tags) for active channels using the configured HTTP client; handles API-specific authentication using the configured Twitch `Client ID` and appropriate OAuth token (App Access Token recommended for public data); adheres to Helix API rate limits.
    *   Technology: Node.js HTTP client library (e.g., `axios`), Twitch Helix API. The use of a standard library like `axios` is recommended due to its maturity, widespread adoption, and features like promise-based requests and interceptors, which can be useful for centralized handling of authentication or logging.
    *   Dependencies: Requires `TWITCH_CLIENT_ID` and appropriate credentials (e.g., `TWITCH_CLIENT_SECRET` or OAuth token) from configuration.
*   **LLM Interaction (`@google/generative-ai`):**
    *   Responsibilities: Constructs prompts incorporating context provided by the Context Manager; sends requests to the configured Google Gemini model via the `@google/generative-ai` SDK; processes responses received from the LLM; handles API-specific errors and rate limits related to the Gemini service.
    *   Technology: `@google/generative-ai` Node.js SDK.
*   **Context Manager:**
    *   Responsibilities: Maintains state for each channel the bot operates in; stores recent chat messages (`chatHistory`); generates and stores summaries of longer conversations (`chatSummary`); stores and updates current stream information (`streamContext`) fetched via the Helix API Interface; provides consolidated context (chat history, summary, stream info) to the LLM Interaction component upon request.
    *   State Management: The mechanism for persisting state (in-memory, database, cache) will depend on deployment architecture and scalability requirements. Platforms like `Kubernetes` offer `Persistent Volumes` suitable for stateful applications, while serverless environments like `Cloud Run` might necessitate external stores (e.g., `Redis`, `Firestore`) to maintain state across potentially ephemeral instances. This choice impacts how state survives restarts or scaling events and should be made considering the expected operational environment.
*   **Command Processor:**
    *   Responsibilities: Identifies and parses bot-specific commands received from chat messages; executes corresponding command logic, potentially interacting with other components (e.g., Context Manager for data, LLM Interaction for complex queries, Helix API Interface for actions).
*   **Configuration Manager:**
    *   Responsibilities: Loads application configuration from environment variables or configuration files at startup; provides type-safe access to configuration parameters for other components.
*   **Logger:**
    *   Responsibilities: Provides a standardized interface for logging application events, warnings, and errors; supports different log levels (debug, info, warn, error, fatal); formats logs, preferably in a structured format (e.g., `JSON`) for easier analysis; integrates with appropriate logging transports (e.g., console, file, cloud logging services like `Google Cloud Logging`).

## 2.3 Data Flow

1.  **Initialization:** Bot starts, Configuration Manager loads settings (including Twitch Client ID/Secret, API keys), Logger is initialized. Twitch IRC Interface connects and authenticates using the bot's OAuth token. Twitch Helix API Interface authenticates (e.g., obtains an App Access Token using `Client ID` and `Secret` via the `Client Credentials` flow).
2.  **Periodic Stream Info Fetch:** The Twitch Helix API Interface, triggered by a timer based on `STREAM_INFO_FETCH_INTERVAL_SECONDS`, makes a `Get Channel Information` request (`GET /helix/channels`) to the Helix API for each active channel, providing the `broadcaster_id` and necessary authentication headers (`Client ID` and `OAuth` token).
3.  **Stream Info Update:** The successful response from Helix (containing game, title, tags) is passed to the Context Manager, which updates the `streamContext` for the corresponding channel, including a `lastUpdated` timestamp. Errors during the fetch are logged and handled according to Section 5.4.
4.  **Chat Message Received:** Twitch IRC Interface receives a message via `tmi.js`, including message content and user tags.
5.  **Context Gathering:** The message is passed to the Context Manager, which updates the `chatHistory` for the channel. If the message is not a command and requires an LLM response, the Context Manager retrieves the current `chatSummary`, relevant `chatHistory`, and the latest `streamContext` from its state for that channel.
6.  **LLM Prompting:** The LLM Interaction component receives the assembled context, formats it into the defined prompt structure (Section 3.3.1), including the fetched stream info, and sends it to the Gemini API using `@google/generative-ai`.
7.  **LLM Response:** Gemini API processes the prompt and returns a generated text response. Errors (API errors, safety blocks) are handled according to Section 5.3.
8.  **Response Processing:** The LLM Interaction component receives the response text. It may undergo post-processing if needed (e.g., filtering, formatting).
9.  **Send Chat Message:** The processed response is sent to the Twitch IRC Interface, which uses `tmi.js`'s `say` or `action` method to send the message back to the appropriate Twitch channel, respecting IRC rate limits (Section 4.1).
10. **Chat Summarization:** Periodically or based on history length/token count, the Context Manager may invoke the LLM Interaction component to summarize the `chatHistory`, updating the `chatSummary` for the channel to manage context size.

(A data flow diagram illustrating steps 2, 3, 5, and 6 should be included here).

## 2.4 Configuration Management

The bot's behavior is configured through environment variables or a configuration file loaded at startup. The following parameters are essential:

| Parameter Name                         | Environment Variable                   | Type     | Description                                                                                                                    | Required? | Default Value        | Security Sensitive? |
| :------------------------------------- | :------------------------------------- | :------- | :----------------------------------------------------------------------------------------------------------------------------- | :-------- | :------------------- | :------------------ |
| `TWITCH_BOT_USERNAME`                  | `TWITCH_BOT_USERNAME`                  | `String` | The Twitch username of the bot account.                                                                                          | Yes       | -                    | No                  |
| `TWITCH_BOT_OAUTH_TOKEN`               | `TWITCH_BOT_OAUTH_TOKEN`               | `String` | OAuth token (`oauth:...`) for the bot account to connect to Twitch IRC and send messages.                                        | Yes       | -                    | Yes                 |
| `TWITCH_CHANNELS`                      | `TWITCH_CHANNELS`                      | `String` | Comma-separated list of Twitch channel names (without '#') to join.                                                            | Yes       | -                    | No                  |
| `GEMINI_API_KEY`                       | `GEMINI_API_KEY`                       | `String` | API key for accessing the Google Gemini API.                                                                                   | Yes       | -                    | Yes                 |
| `GEMINI_MODEL_ID`                      | `GEMINI_MODEL_ID`                      | `String` | The specific Gemini model to use (e.g., `gemini-2.0-flash-001`).                                                                 | Yes       | `gemini-2.0-flash-001` | No                  |
| `TWITCH_CLIENT_ID`                     | `TWITCH_CLIENT_ID`                     | `String` | The Client ID for the registered Twitch application, required for Helix API calls.                                               | Yes       | -                    | Yes                 |
| `TWITCH_CLIENT_SECRET`                 | `TWITCH_CLIENT_SECRET`                 | `String` | The Client Secret for the registered Twitch application. Required if using Client Credentials flow for App Access Token.       | Maybe     | -                    | Yes                 |
| `STREAM_INFO_FETCH_INTERVAL_SECONDS` | `STREAM_INFO_FETCH_INTERVAL_SECONDS` | `Number` | Frequency (in seconds) to fetch stream info from Helix API.                                                                    | No        | 120                  | No                  |
| `LOG_LEVEL`                            | `LOG_LEVEL`                            | `String` | Minimum log level to output (e.g., 'debug', 'info', 'warn', 'error').                                                          | No        | `info`               | No                  |
| (Other existing parameters...)         | (...)                                  | ...      | (...)                                                                                                                          | ...       | ...                  | ...                 |

**Security Note:** Credentials such as `TWITCH_BOT_OAUTH_TOKEN`, `GEMINI_API_KEY`, `TWITCH_CLIENT_ID`, and `TWITCH_CLIENT_SECRET` are highly sensitive and must not be hardcoded into the source code or committed to version control. The recommended approach is to inject these values via environment variables at runtime. In cloud deployment scenarios (e.g., `Google Cloud Run`, `GKE`), leveraging a dedicated secrets management service like `Google Cloud Secret Manager` or `HashiCorp Vault` is strongly advised for enhanced security and compliance with `OWASP` best practices. This separation of configuration and secrets from the codebase is crucial for security, especially now that the bot requires credentials for both IRC and the Helix API. The addition of Helix API credentials increases the application's security surface area, making robust secret management even more critical.

The `STREAM_INFO_FETCH_INTERVAL_SECONDS` default of 120 seconds (2 minutes) represents a balance between keeping the stream context reasonably fresh and avoiding excessive calls to the Twitch Helix API, thereby conserving rate limit points. Fetching data like stream title and game too frequently often yields redundant information while still consuming API quota.

# 3. LLM Integration (`@google/generative-ai`)

## 3.1 Model Selection

The primary LLM for this bot will be a Google Gemini model, accessed via the `@google/generative-ai` SDK. The recommended model is `gemini-2.0-flash-001` (or the latest stable `gemini-2.0-flash` alias), offering a balance of performance, cost-efficiency, and multimodal capabilities suitable for this application. The specific model ID used should be configurable via the `GEMINI_MODEL_ID` parameter. The latest stable version identifier (e.g., `gemini-2.0-flash-001`) is preferred over aliases like `gemini-2.0-flash` for production environments to ensure predictable behavior, as aliases can point to updated models over time.

## 3.2 API Interaction

All interactions with the Gemini API will be handled through the `@google/generative-ai` Node.js SDK. This includes:

*   Initializing the client with the `GEMINI_API_KEY`. Server-side initialization is recommended for security.
*   Selecting the appropriate model (`GEMINI_MODEL_ID`).
*   Calling the `generateContent` method with the constructed prompt (including chat history, summary, and stream context) and relevant generation configuration (e.g., `safety settings`, `temperature`, `max output tokens`).
*   Handling streaming responses if implemented for faster perceived response times.
*   Parsing responses and handling potential API errors (see Section 5.3).

## 3.3 Prompting Strategy

### 3.3.1 Prompt Structure

To provide the LLM with sufficient context for generating relevant and aware responses, a structured prompt format will be used. This structure includes static labels and dynamic placeholders populated by the Context Manager. The inclusion of real-time stream information is crucial for enhancing the bot's awareness of the current broadcast state.

**Standard Prompt Structure:**

```
**Current Stream Information:**
Game: {stream_game}
Title: {stream_title}
Tags: {stream_tags}

**Chat Summary:**
{chat_summary}

**Recent Messages:**
{recent_chat_history}

**New message from {username}:** {current_message}

Bot Response:
```

*   **Placeholders:**
    *   `{stream_game}`: Populated with the current game name from `streamContext.game`. Will be "N/A" or similar if context is unavailable or stream is offline.
    *   `{stream_title}`: Populated with the current stream title from `streamContext.title`. Will be "N/A" if unavailable.
    *   `{stream_tags}`: Populated with a comma-separated list of current stream tags from `streamContext.tags`. Will be "N/A" if unavailable.
    *   `{chat_summary}`: Populated with the condensed summary of the conversation history managed by the Context Manager. This helps retain context from older parts of the conversation without exceeding token limits.
    *   `{recent_chat_history}`: Populated with a limited number of the most recent chat messages (e.g., last 5-10 messages) from `chatHistory`. This provides immediate conversational context.
    *   `{username}`: The display name of the user who sent the latest message (obtained from `tmi.js` tags).
    *   `{current_message}`: The content of the latest message triggering the LLM response.

**Context vs. Efficiency:** Adding the **Current Stream Information** block significantly enhances the LLM's ability to provide responses relevant to the ongoing stream activity (e.g., answering questions about the game being played). However, this directly increases the number of input tokens sent with every request to the Gemini API. This has implications for both API costs (often token-based) and response latency, as larger prompts take longer to process. The current design prioritizes contextual relevance over minimizing token count. Should cost or latency become significant concerns during operation, future optimizations might involve: \* Conditionally including stream information only when message analysis suggests it's relevant. \* Further summarizing the stream information or only including changes since the last interaction. \* Adjusting the frequency of stream info updates (`STREAM_INFO_FETCH_INTERVAL_SECONDS`) to reduce API calls and potentially stale context inclusion.

**Structured Output Considerations:** This prompt structure provides stream information as context to the LLM. If the bot required the LLM to generate structured data (e.g., extracting specific entities from chat related to the stream game), relying solely on natural language instructions within the prompt (e.g., "Respond in JSON format") can be unreliable, as the model might fail to adhere strictly to the requested format. For guaranteed structured output, the `@google/generative-ai` SDK's `responseSchema` feature or the `function calling` mechanism should be employed in future revisions if such functionality is needed. `responseSchema` allows defining a specific `JSON` schema that the model is constrained to follow, while `function calling` enables the model to request the execution of predefined application functions with structured arguments. For the current requirement of simply informing the LLM about the stream state, including the information directly in the prompt is sufficient.

# 4. Rate Limiting

The bot interacts with two distinct Twitch services (IRC and Helix API), each with its own rate-limiting mechanisms. Adherence to these limits is critical for stable operation and avoiding service disruptions or temporary bans.

## 4.1 Twitch IRC Rate Limits

Twitch IRC imposes limits on the number of messages (`PRIVMSG`) a connected client can send within a 30-second window. These limits are applied per user account, meaning all connections originating from the same bot account share the same message bucket. The limits vary based on the bot account's status in the specific channel:

*   **Standard User (Non-Mod/VIP/Broadcaster):** 20 messages per 30 seconds.
*   **Moderator/VIP/Broadcaster:** 100 messages per 30 seconds. Note: VIP status grants immunity to slow mode and chat rate limits but not direct moderation actions. Messages sent by privileged users still count towards the standard 20/30s limit but can continue up to the 100/30s limit if the standard limit is exceeded.
*   **Verified Bot:** 7500 messages per 30 seconds. Verified status is granted by Twitch upon request for popular bots meeting certain criteria.

Additionally, there is a stricter limit for non-privileged users: 1 message per second per channel. Sending messages faster than this, even if within the 30-second overall limit, may result in messages being dropped, potentially due to anti-spam measures.

Exceeding these limits can result in messages being silently dropped or the bot account being temporarily locked out (e.g., for 30 minutes or longer).

The `tmi.js` library may incorporate some basic handling (e.g., default join intervals), but the application logic must be designed to prevent message flooding. This includes queuing responses if necessary, adding delays between messages (especially for non-mod status), and being mindful of command triggers that could generate rapid replies across many channels simultaneously. `AutoMod` interactions can also affect perceived message delivery without violating rate limits. `JOIN` commands also have their own rate limits (e.g., 20/2000 per 10s for standard/verified bots).

## 4.2 Twitch Helix API Rate Limits

Interaction with the Twitch Helix API is subject to a separate rate-limiting system based on a points bucket, distinct from IRC message limits.

*   **Mechanism:** Twitch uses a token-bucket algorithm. Each application (identified by `Client ID`) is allocated a bucket of points that replenishes over time (typically per minute). API calls consume points from this bucket. If the bucket is empty when a request is made, the API returns an `HTTP 429 Too Many Requests` error.
*   **Default Limit:** The default rate limit bucket size is 800 points per minute when using a `User` or `App Access Token`. Unauthenticated requests (not applicable here as a `Client ID` and OAuth token are required) have a much lower limit (e.g., 30 points per minute).
*   **Point Cost:** Most standard `GET` requests, including `Get Channel Information`, consume 1 point per request. Some endpoints may have different costs, as specified in their documentation.
*   **Scope:** Limits for requests using an `App Access Token` are per `Client ID`. Limits for requests using a `User Access Token` are applied per `Client ID` per user per minute. This means if the bot uses `User Tokens` for multiple channels, each user's token has its own 800-point bucket associated with the bot's `Client ID`. If using a single `App Token`, all requests share the same 800-point bucket.
*   **Monitoring:** The API provides headers in each response to help track usage and avoid exceeding limits:
    *   `Ratelimit-Limit`: The total points capacity of the bucket per window (e.g., 800).
    *   `Ratelimit-Remaining`: The number of points currently available in the bucket.
    *   `Ratelimit-Reset`: A Unix epoch timestamp indicating when the bucket will be fully reset to the `Ratelimit-Limit` value.
*   **Impact:** The frequency set by `STREAM_INFO_FETCH_INTERVAL_SECONDS` directly determines the points consumed per minute per channel for stream context updates. Fetching information for N channels every I seconds consumes approximately (N \* 60 / I) points per minute from the shared `App Token` bucket or from each `User Token` bucket involved. For example, fetching for 100 channels every 120 seconds consumes (100 \* 60 / 120) = 50 points per minute.
*   **Requirement:** The implementation must handle potential `429 Too Many Requests` errors from the Helix API (see Section 5.4). While sophisticated dynamic rate adjustment based on remaining points (e.g., adaptive rate limiting) is not mandated for this version, logging the `Ratelimit-Remaining` header (see Section 5.5) is recommended for monitoring. The chosen `STREAM_INFO_FETCH_INTERVAL_SECONDS` should provide a reasonable buffer under expected load. Frequent `429` errors indicate the interval may be too short or the bot is operating in too many channels for the default limit.

# 5. Error Handling

Robust error handling is essential for maintaining bot stability, ensuring data integrity, and providing informative diagnostics for troubleshooting.

## 5.1 General Strategy

*   Log all significant errors with detailed context (timestamp, component, error message, stack trace where applicable). Use structured logging (Section 5.5) for better machine readability and analysis.
*   Implement retry mechanisms with exponential backoff and jitter for transient network or server-side errors where appropriate. Define maximum retry attempts to prevent indefinite loops.
*   Gracefully degrade functionality where possible. For instance, if stream info fetching fails repeatedly, the bot should continue to function using only chat context, potentially notifying moderators or logging the degradation.
*   Avoid crashing the application due to unhandled promise rejections or exceptions. Implement global error handlers or ensure all asynchronous operations have appropriate `.catch()` blocks.

## 5.2 `tmi.js` Errors

Handle errors related to the IRC connection lifecycle and message handling:

*   Connection failures during initial `connect()`: Log error, potentially retry connection based on configuration.
*   Authentication failures (invalid OAuth token): Log critical error, halt connection attempts for the bot account, signal configuration issue.
*   Disconnections (`disconnected` event): Log the reason for disconnection. Attempt reconnection based on the `connection.reconnect` configuration option.
*   Reconnection failures (`maxreconnect` event): Log critical error after exhausting retry attempts. Potentially stop bot operation for the affected channel(s) or globally, depending on the desired fault tolerance.
*   Errors sending messages (e.g., attempting `client.say()` before the `connected` event fires, permission errors for commands like `/host` if the bot lacks editor/broadcaster status, sending non-string data). Log the error and the message content that failed.

## 5.3 `@google/generative-ai` Errors

Handle errors originating from the Google Gemini API interactions:

*   Authentication errors (invalid `GEMINI_API_KEY`): Typically results in `PERMISSION_DENIED` (`HTTP 403`). Log critical error, halt LLM requests, signal configuration issue.
*   Rate limit exceeded (`RESOURCE_EXHAUSTED`, `HTTP 429`): Log warning/error. Implement exponential backoff before retrying the request. Consider adjusting request frequency if this occurs often.
*   Invalid arguments (malformed request body, invalid model ID, `HTTP 400 INVALID_ARGUMENT`): Log error, including request details if possible. Check request formatting against API reference and configuration. Do not retry without correcting the request. Errors like `FAILED_PRECONDITION` (`HTTP 400`) might indicate billing or regional availability issues.
*   Safety blocks (`FinishReason.SAFETY` in response): Log the block reason provided in the response. Review the prompt content and the generated (blocked) response against the configured safety settings (`HarmCategory`, `HarmBlockThreshold`). Adjust safety thresholds cautiously if legitimate content is being blocked, or modify prompts to avoid triggering filters. `BlockedReason.OTHER` may indicate Terms of Service violations and requires careful review.
*   Server-side errors (`HTTP 500 INTERNAL`, `503 UNAVAILABLE`, `504 DEADLINE_EXCEEDED`): Treat as transient errors potentially caused by server overload, long context, or temporary unavailability. Implement retry logic with exponential backoff. For persistent `5xx` errors, log critically and consider temporarily switching to a fallback model if configured. `DEADLINE_EXCEEDED` might specifically indicate the prompt context is too large.
*   Specific SDK errors (e.g., `GoogleGenerativeAIFetchError`, `APIError`, `ClientError`, `ServerError`): Handle based on the underlying HTTP status code or error type provided by the SDK.

## 5.4 Twitch Helix API Errors

Implement specific handling for errors encountered during calls made by the Twitch Helix API Interface to endpoints like `GET /helix/channels`:

*   **Network Errors:** Includes connection timeouts, DNS resolution failures (`EAI_AGAIN`), or `TCP` connection resets (`ECONNRESET`, `ECONNREFUSED`). These are typically transient and indicate issues reaching Twitch's servers.
    *   Handling: Implement a retry strategy using exponential backoff (e.g., wait 1s, 2s, 4s,...) with jitter (adding a small random delay) to avoid synchronized retries from multiple instances. Limit the number of retries (e.g., 3-5 attempts) before considering the fetch failed for this interval. Log each failed attempt and the eventual success or final failure.
*   **HTTP 401 Unauthorized:** Indicates an issue with the provided `OAuth` token (App or User) or `Client ID`. The token might be expired, revoked, invalid, or the `Client ID` used to generate it doesn't match the one in the `Client-Id` request header. The response body often contains `{"status": 401, "message": "invalid access token"}` or similar.
    *   Handling: Log the error clearly, indicating an authentication failure. Do not retry the request with the same credentials. If using User Tokens with refresh capabilities, trigger the token refresh mechanism (Section 7.4). If using App Tokens or if the refresh fails, signal a critical configuration error. Consider halting stream info polling for the affected channel or globally until the authentication issue is manually resolved.
*   **HTTP 403 Forbidden:** Indicates the authenticated entity (app or user) lacks the necessary permissions (scopes) for the requested resource or action. This is unlikely for `Get Channel Information` with a valid token but could occur with other endpoints if functionality expands.
    *   Handling: Log the error. Verify the scopes associated with the OAuth token (if applicable) against the API endpoint requirements documented by Twitch. This typically indicates a configuration or programming error (requesting an endpoint without the required scope). Do not retry.
*   **HTTP 429 Too Many Requests:** Signals that the API rate limit (points bucket) has been exceeded.
    *   Handling: Log a warning or error, including the endpoint that was rate-limited. Extract the `Ratelimit-Reset` Unix timestamp from the response headers. Implement a retry mechanism that waits until after the specified reset time before attempting the request again. Add a small buffer (e.g., 1 second) to the wait time to account for potential clock skew. Avoid immediate retries. If `429` errors occur frequently, investigate the cause: Is `STREAM_INFO_FETCH_INTERVAL_SECONDS` too low? Is the bot in too many channels? Is another part of the application consuming the rate limit? Consider increasing the interval or implementing more sophisticated adaptive rate limiting.
*   **HTTP 5xx Errors** (e.g., `500 Internal Server Error`, `502 Bad Gateway`, `503 Service Unavailable`, `504 Gateway Timeout`): Indicate temporary problems on Twitch's server-side. These are generally considered retryable.
    *   Handling: Treat as transient errors. Implement a retry strategy using exponential backoff with jitter, similar to network errors. Log each failed attempt and the eventual success or final failure. If errors persist after multiple retries over a period, log a critical error and potentially temporarily disable polling for that channel or globally to avoid contributing to server load during an outage.

## 5.5 Logging Requirements for API Calls

To ensure adequate observability of interactions with the Twitch Helix API, structured logging is required. All logs related to Helix API calls should be emitted in `JSON` format, including standard fields like timestamp, log level, and message, plus context-specific fields. Recommended logging libraries include `pino` or `winston`, potentially integrated with cloud logging providers (e.g., `@google-cloud/logging-winston`, `@google-cloud/pino-logging-gcp-config`).

*   **On Request Start:** Log the attempt to call the API at `DEBUG` or `INFO` level.
    *   Required Fields: `message` (e.g., "Calling Helix API"), `apiEndpoint` (e.g., "/helix/channels"), `httpMethod` ("GET"), `channelId` (the broadcaster ID being queried, if applicable).
*   **On Request Success:** Log the successful completion of the API call at `INFO` level.
    *   Required Fields: `message` (e.g., "Helix API call successful"), `apiEndpoint`, `httpMethod`, `channelId` (if applicable), `httpStatusCode` (e.g., 200), `latencyMs` (duration of the call from start to finish).
    *   Recommended Fields: `rateLimitRemaining` (parsed integer value from `Ratelimit-Remaining` header). Logging this helps diagnose rate limit issues.
*   **On Request Failure:** Log the failed API call at `WARN` or `ERROR` level depending on the status code (e.g., WARN for 429, ERROR for 401, 5xx).
    *   Required Fields: `message` (e.g., "Helix API call failed"), `apiEndpoint`, `httpMethod`, `channelId` (if applicable), `httpStatusCode` (e.g., 429, 503), `errorDetails` (content of the error response body or error message from the HTTP client), `latencyMs`.

This structured approach facilitates easier parsing, filtering, and alerting in log aggregation and monitoring systems (like `Google Cloud Logging`, `Datadog`, `Sentry`), which is crucial for diagnosing intermittent API issues (like transient 503s or rate limits) and monitoring the performance and reliability of the Helix integration.

# 6. Context Management

The bot maintains state independently for each channel it joins. This state forms the context provided to the LLM for generating responses, ensuring relevance to the specific channel's ongoing conversation and stream status.

## 6.1 Overview

The Context Manager component is responsible for storing and retrieving channel-specific state. This state now includes not only chat history and summaries but also the periodically fetched stream context. The persistence strategy for this state (in-memory, database, external cache like `Redis`) should be determined based on deployment architecture (e.g., single instance vs. clustered/serverless) and scalability requirements. The chosen strategy must ensure state consistency and availability appropriate for the application's needs.

## 6.2 Chat History & Summarization

The bot retains a history of recent chat messages (`chatHistory`) for each channel. To manage context window limitations and the associated costs and latency of passing very long conversations to the LLM, a summarization strategy is employed. Periodically, or when the chat history exceeds a defined threshold (based on token count or message count), the Context Manager utilizes the LLM Interaction component to generate a concise summary (`chatSummary`) of the preceding conversation. This summary, along with the most recent messages (`buffering`), forms the chat-based context for subsequent LLM prompts. Techniques like simple `stuffing`, `map-reduce` for very large contexts, or `recursive summarization` can be considered. The summarization prompt should instruct the LLM to retain key information, user intents, and conversational flow. `Vector databases` offer an alternative for long-term memory, storing conversation chunks or summaries and retrieving relevant parts based on semantic similarity to the current query or context.

## 6.3 Stream Context

To enhance contextual awareness, the Context Manager now incorporates real-time stream information fetched from the Twitch Helix API.

*   **Fetching Mechanism:** The Twitch Helix API Interface is responsible for fetching this data. It will periodically invoke the `Get Channel Information` endpoint (`GET https://api.twitch.tv/helix/channels`) on the Twitch Helix API.
    *   Endpoint Rationale: This endpoint is chosen because it returns the necessary fields (`game_id`, `game_name`, `title`, `tags`, `broadcaster_language`, `content_classification_labels`, `is_branded_content`) with a single request using the `broadcaster_id`. Crucially, accessing this public data does not require specific `OAuth` scopes beyond standard authentication with a valid `App` or `User` token. While `Get Streams` provides live status and viewer count, `Get Channel Information` provides the last known game/title even if the stream is currently offline, which might be useful context for answering questions when the streamer is not live. The fields `game_name`, `title`, and `tags` are the primary targets for inclusion in the LLM prompt.
*   **Fetch Trigger:** The fetch operation for a given channel is triggered by a timer based on the `STREAM_INFO_FETCH_INTERVAL_SECONDS` configuration parameter (default: 120 seconds). Fetches should ideally be staggered across channels or managed efficiently within a single loop to avoid sending bursts of requests to the API, especially when connected to many channels, helping to manage rate limits.
*   **Storage:** The fetched stream information must be stored within the channel's state object managed by the Context Manager. A potential structure for this part of the state is:

```typescript
interface StreamContext {
 game: string | null;
 title: string | null;
 tags: string | null;
 // Optional additional fields from Get Channel Info:
 // language: string | null;
 // classificationLabels: string | null;
 // isBranded: boolean | null;
 lastUpdated: Date | null; // Timestamp of the last successful fetch
 fetchErrorCount: number; // Count consecutive fetch errors
}

interface ChannelState {
 //... existing chatHistory: Message, chatSummary: string...
 streamContext: StreamContext;
 //... other state like user permissions cache...
}
```

The `lastUpdated` timestamp helps in understanding context freshness and potentially optimizing fetches (e.g., fetching less frequently if the stream appears offline or context hasn't changed). The `fetchErrorCount` can help decide when to temporarily stop polling a channel after repeated failures. If an API call fails, the existing context should be retained but marked as potentially stale.

## 6.4 Context Provisioning

### 6.4.1 Context Provisioning for LLM

When a response needs to be generated by the LLM, the Context Manager assembles the required context from the channel's state.

*   Update: In addition to retrieving the `chatSummary` and recent `chatHistory`, the system must retrieve the current `streamContext` (specifically `game`, `title`, and `tags`) from the channel's state object.
*   Population: These retrieved stream context values are then used to populate the corresponding placeholders (`{stream_game}`, `{stream_title}`, `{stream_tags}`) in the standard LLM prompt structure defined in Section 3.3.1. If stream context is unavailable (e.g., first fetch hasn't completed) or considered stale (e.g., `lastUpdated` is too old, or repeated fetch errors occurred), appropriate default values (e.g., "N/A", "Unknown", "Stream information unavailable") should be used in the prompt placeholders.

### 6.4.2 Context Provisioning for Commands

If specific bot commands require knowledge of the current stream game, title, or tags to function correctly (e.g., a `!game` command):

*   Update: The command processing logic should be updated to retrieve the necessary `streamContext` data directly from the channel's state object via the Context Manager. Commands should gracefully handle cases where this context might be missing or stale, potentially informing the user that the information is currently unavailable.

# 7. Security Considerations

Maintaining the security and integrity of the bot, user data, and associated credentials is paramount.

## 7.1 Authentication (Bot Account)

The bot authenticates with Twitch IRC using the configured `TWITCH_BOT_USERNAME` and `TWITCH_BOT_OAUTH_TOKEN` via `tmi.js`. This token grants the ability to read and send chat messages as the bot user and must be kept confidential. Best practices for generating and storing this token should be followed.

## 7.2 Authorization (Bot Commands)

Access control for privileged bot commands (e.g., commands restricted to moderators or the broadcaster) must be implemented robustly. This typically involves checking the `tags` object provided by `tmi.js` with each message for moderator or broadcaster badges (`tags.badges.moderator`, `tags.badges.broadcaster`) or comparing `tags.username` with the channel name (stripping the leading '#'). Checking `client.userstate[channel].mod` determines if the bot itself has moderator privileges in that channel, which might be necessary for actions like deleting messages or changing chat modes. Relying solely on `user-type === 'mod'` might be less reliable than checking badges.

## 7.3 Data Privacy

User chat messages processed by the bot, especially those passed to the external LLM service, should be handled responsibly. Avoid logging excessive personal or sensitive information revealed in chat. Ensure compliance with relevant data privacy regulations (e.g., `GDPR`, `CCPA`) regarding data storage, processing, and user rights.

## 7.4 OAuth Token Lifecycle Management

Interaction with the Twitch Helix API requires `OAuth 2.0` authentication using either an `App Access Token` or a `User Access Token`. Proper management of these tokens and associated credentials is critical.

*   **Token Type Recommendation:** For the current scope of fetching public channel information (game, title, tags via `Get Channel Information`), an `App Access Token` is sufficient and recommended. This token represents the application itself, not a specific user.
*   **Obtainment (App Access Token):** `App Access Tokens` are obtained using the `Client Credentials Grant Flow`. This flow requires the application's `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` and involves a direct server-to-server `POST` request to the Twitch token endpoint (`https://id.twitch.tv/oauth2/token`) with `grant_type=client_credentials`. It does not require user interaction.
*   **Rationale:** This simplifies the authentication process, avoids the need for user consent for accessing public data, and is generally suited for backend services performing actions on behalf of the application itself.
*   **User Access Tokens:** If future functionality requires accessing user-specific private data (e.g., reading subscriber lists via `Get Broadcaster Subscriptions`, reading user email) or performing actions on behalf of a user (e.g., running polls, modifying channel info), a `User Access Token` will be necessary.
*   **Obtainment (User Access Token):** `User Access Tokens` should be obtained using the `Authorization Code Grant Flow`. This flow involves redirecting the user to Twitch to authorize the requested scopes, receiving an authorization code back via a registered redirect URI, and then exchanging this code (along with `Client ID` and `Secret`) for the access and refresh tokens via a server-side `POST` request to the token endpoint with `grant_type=authorization_code`. The `Implicit Grant Flow` returns the token directly in the redirect URL fragment but is less secure (exposes token to browser) and does not provide a refresh token, making it unsuitable for long-running server applications. The `Device Code Grant Flow` is an alternative for devices without easy browser input but is more complex than Authorization Code for a typical bot backend.
*   **Scope Requirements:**
    *   For fetching public `game_name`, `title`, and `tags` using `GET /helix/channels`, no specific `OAuth` scopes are required beyond standard authentication with a valid `App` or `User` token. The application must only request the scopes necessary for its functionality, adhering to the principle of least privilege. Requesting unnecessary scopes can lead to app suspension by Twitch.
    *   The following table documents the scope requirement for the current feature and provides a template for future additions:

    | Feature                              | Required Scope(s)            | API Endpoint(s)         | Justification                                                            |
    | :----------------------------------- | :--------------------------- | :---------------------- | :----------------------------------------------------------------------- |
    | Fetch Stream Info (Game, Title, Tags) | None (using App/User Token) | `GET /helix/channels`   | Accessing public channel data via `Get Channel Information` endpoint.    |
    | (Future: Read Polls)                | (`channel:read:polls`)      | (`GET /helix/polls`)    | (Required to read poll data for a specific channel)                     |
    | (Future: Manage Broadcast)          | (`channel:manage:broadcast`) | (`PATCH /helix/channels`) | (Required to update channel info like title/game via API)               |

*   **Secure Credential Storage:** As stated in Section 2.4, the `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` (if using Client Credentials or Authorization Code flows) or any obtained `User OAuth Access Tokens` and `Refresh Tokens` (if using Authorization Code flow) must be stored securely. Use environment variables managed securely or preferably a dedicated secrets management system (e.g., `Google Secret Manager`, `AWS Secrets Manager`, `HashiCorp Vault`). Avoid hardcoding secrets in source code. Regularly rotate keys where feasible. This is a critical security measure to prevent unauthorized API access, especially given the bot now manages multiple sets of credentials.
*   **Token Validation:**
    *   **App Access Tokens:** These tokens expire after a period specified in the `expires_in` field of the token response. While hourly validation via `/oauth2/validate` isn't mandated by Twitch for app tokens as it is for user sessions, the application should handle `401 Unauthorized` errors on API calls by attempting to regenerate a new `App Access Token` using the `Client Credentials` flow. Caching the App Token until it expires or fails is recommended.
    *   **User Access Tokens (If Used):** If `User Access Tokens` are implemented (now or in the future), the application must validate the token hourly using the `GET https://id.twitch.tv/oauth2/validate` endpoint. This is a Twitch requirement for third-party applications maintaining OAuth sessions. This validation checks if the token is still active and hasn't been revoked by the user (e.g., via Twitch settings) or invalidated for other reasons. Failure to perform this validation can lead to punitive action from Twitch. A `401` response from the validate endpoint indicates the token is invalid, and the application should treat the user as logged out and discard the associated tokens.
*   **Token Refresh (If User Token Used):**
    *   The `Authorization Code Grant Flow` provides a `refresh token` alongside the `access token`. This refresh token must be stored securely alongside the access token. Refresh tokens allow obtaining new access tokens without requiring the user to re-authorize, maintaining a persistent connection.
    *   When a `User Access Token` expires (indicated by the `expires_in` field during initial grant or refresh, or by receiving a `401 Unauthorized` response from an API call), the application must use the stored refresh token, `Client ID`, and `Client Secret` to request a new access token and potentially a new refresh token from `https://id.twitch.tv/oauth2/token` using `grant_type=refresh_token`.
    *   The new tokens (access and potentially refresh) received from a successful refresh request must replace the old ones in secure storage. Refresh tokens themselves can become invalid (e.g., user changes password, revokes app access, or for Public clients after 30 days). Failed refresh attempts (e.g., `400 Bad Request` with "Invalid refresh token", or `401 Unauthorized`) indicate the refresh token is no longer valid, and the user must be prompted to re-authenticate via the full `Authorization Code Grant Flow`.

# 8. Project Setup / Dependencies

## 8.1 Language/Runtime

*   `Node.js` (Version 18 or later recommended)

## 8.2 Key Dependencies

The following Node.js packages form the core dependencies for the StreamSage:

*   `tmi.js`: Core library for Twitch IRC chat interaction (connection, message send/receive).
*   `@google/generative-ai`: Official SDK for interacting with the Google Gemini LLM API.
*   `axios`: Recommended HTTP client for making RESTful requests to the Twitch Helix API. Provides promise-based API and robust error handling capabilities.
*   **Logging Library** (Choose one and its cloud integration if applicable):
    *   `winston`: A popular, versatile logging library.
    *   `@google-cloud/logging-winston`: Winston transport for Google Cloud Logging.
    *   `pino`: A high-performance JSON logger.
    *   `@google-cloud/pino-logging-gcp-config`: Configuration helper for Pino to output GCP-compatible structured logs.
*   **Secrets Management Client** (Optional, recommended for cloud deployments):
    *   `@google-cloud/secret-manager`: Client library for Google Cloud Secret Manager.
*   (Other necessary utility libraries, e.g., for date handling, configuration loading)

The selection of logging and secrets management libraries should align with the chosen deployment environment and infrastructure (e.g., prefer GCP integrations if deploying on Google Cloud).

## 8.3 Setup Instructions

Standard Node.js project setup using `npm` or `yarn`. Key dependencies are installed via the package manager.

Example using `npm`:

```bash
# Core dependencies
npm install tmi.js @google/generative-ai axios

# Choose and install ONE logging option
npm install winston                 # Option 1a: Winston core
npm install @google-cloud/logging-winston # Option 1b: Winston GCP integration (optional)
# --- OR ---
npm install pino                    # Option 2a: Pino core
npm install @google-cloud/pino-logging-gcp-config # Option 2b: Pino GCP integration (optional)

# Optional: Secret Management client (if using GCP Secret Manager)
npm install @google-cloud/secret-manager
```

Example using `yarn`:

```bash
# Core dependencies
yarn add tmi.js @google/generative-ai axios

# Choose and install ONE logging option
yarn add winston                    # Option 1a: Winston core
yarn add @google-cloud/logging-winston # Option 1b: Winston GCP integration (optional)
# --- OR ---
yarn add pino                       # Option 2a: Pino core
yarn add @google-cloud/pino-logging-gcp-config # Option 2b: Pino GCP integration (optional)

# Optional: Secret Management client (if using GCP Secret Manager)
yarn add @google-cloud/secret-manager
```

## 8.4 Configuration

Refer to Section 2.4 for a detailed list of required configuration parameters. Ensure all sensitive credentials (`TWITCH_BOT_OAUTH_TOKEN`, `GEMINI_API_KEY`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`) are configured securely using environment variables or a secrets management system, not hardcoded in the application source code or committed to version control. The application should fail fast at startup if required configurations are missing.

# 9. Conclusion

This specification (Version 1.0) outlines the design for the StreamSage, an AI-powered Twitch chatbot incorporating real-time stream context (game, title, tags) obtained via the Twitch Helix API. This contextual awareness, combined with chat history and summarization, allows the LLM to generate more relevant and engaging responses.

Key technical elements include:

*   A modular architecture using `tmi.js` for IRC chat and `axios` for Helix API interaction.
*   Leveraging the `@google/generative-ai` SDK with a stable Gemini Flash model and integrated Google Search.
*   An autonomous response system using Gemini's structured output (`responseSchema`) for reliable desire assessment.
*   A dynamic response threshold based on smoothed chat velocity.
*   Comprehensive error handling for IRC, Gemini API, and Helix API interactions, including retry logic for transient errors.
*   Mandatory structured logging (`JSON`) for improved observability, particularly for API calls.
*   Acknowledgement of separate IRC and Helix API rate limits and the need for careful management.
*   Prioritization of security through recommended use of secrets management systems for credentials and robust OAuth token lifecycle management (recommending App Access Tokens for current scope).
*   Guidance on project setup, dependencies, and deployment considerations, favouring Google Cloud Run with CI/CD via GitHub Actions.

Successful implementation requires careful attention to authentication flows, secure credential storage, rate limit management for both IRC and Helix API, and robust error handling. The specified structured logging will be crucial for monitoring the health and performance of the integrated components. This specification provides a solid foundation for developing an intelligent, context-aware, and reliable Twitch chatbot.

