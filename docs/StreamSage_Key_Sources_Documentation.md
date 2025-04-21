# Key Sources & Documentation

This document lists the primary sources and documentation pages referenced during the research and creation of the StreamSage Technical Specification (Version 1.0).

(Note: This is not an exhaustive list of every single search result but covers the most influential documentation and discussions used.)

## I. Twitch Developer Documentation (dev.twitch.tv)

*   **Core Concepts & Authentication:**
    *   [Twitch API Overview](https://dev.twitch.tv/docs/api/)
    *   [Authentication Overview](https://dev.twitch.tv/docs/authentication/)
    *   [Getting OAuth Tokens](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/)
    *   [Validating Tokens](https://dev.twitch.tv/docs/authentication/validate-tokens/)
    *   [Refreshing Access Tokens](https://dev.twitch.tv/docs/authentication/refresh-tokens/)
    *   [Twitch Access Token Scopes](https://dev.twitch.tv/docs/authentication/scopes/)
*   **Helix API (REST API):**
    *   [API Guide (Rate Limits, Pagination)](https://dev.twitch.tv/docs/api/guide/)
    *   [API Reference (General)](https://dev.twitch.tv/docs/api/reference/)
    *   [Get Channel Information Endpoint](https://dev.twitch.tv/docs/api/reference/#get-channel-information)
    *   [Get Streams Endpoint](https://dev.twitch.tv/docs/api/reference/#get-streams)
*   **Chat (IRC):**
    *   [Twitch Chat & Chatbots Overview (Includes IRC Rate Limits)](https://dev.twitch.tv/docs/chat/)
    *   [IRC Concepts & Commands](https://dev.twitch.tv/docs/chat/irc/)

## II. Google AI / Gemini Documentation (ai.google.dev, cloud.google.com)

*   **Gemini API Documentation:**
    *   [Gemini Models Overview](https://ai.google.dev/gemini-api/docs/models)
    *   [Generate Content Endpoint](https://ai.google.dev/api/generate-content)
    *   [Structured Output (JSON Mode / responseSchema)](https://ai.google.dev/gemini-api/docs/structured-output)
    *   [Grounding with Google Search (Search Tool)](https://ai.google.dev/gemini-api/docs/grounding)
    *   [Rate Limits](https://ai.google.dev/gemini-api/docs/rate-limits)
    *   [Troubleshooting Guide (Error Codes)](https://ai.google.dev/gemini-api/docs/troubleshooting)
*   **Google GenAI SDK (`@google/genai` for Node.js):**
    *   GitHub Repository (Includes examples & README): [google-gemini/generative-ai-js](https://github.com/google-gemini/generative-ai-js) or [googleapis/js-genai](https://github.com/googleapis/js-genai)
    *   [Google Cloud SDK Overview](https://cloud.google.com/vertex-ai/generative-ai/docs/sdks/overview)
*   **Google Cloud Services:**
    *   [Secret Manager Overview](https://cloud.google.com/security/products/secret-manager)
    *   [Secret Manager Node.js Client Library](https://cloud.google.com/nodejs/docs/reference/secret-manager/latest)
    *   [Cloud Logging Setup for Node.js](https://cloud.google.com/logging/docs/setup/nodejs)
    *   [Cloud Logging Winston Plugin](https://cloud.google.com/nodejs/docs/reference/logging-winston/latest)
    *   [Cloud Logging Pino Config](https://googlecloudplatform.github.io/cloud-solutions/pino-logging-gcp-config/)
    *   [Cloud Run Quickstart (Node.js)](https://cloud.google.com/run/docs/quickstarts/build-and-deploy/deploy-nodejs-service)

## III. `tmi.js` Library

*   [Official Documentation](https://tmijs.com/)
*   GitHub Repository (Issues often contain useful discussions): [tmijs/tmi.js](https://github.com/tmijs/tmi.js) (e.g., Issues #415, #449 regarding mod status)

## IV. Node.js Security & Best Practices

*   [OWASP Cheat Sheet Series (Authentication, Secrets Management, Node.js Security)](https://cheatsheetseries.owasp.org/)
*   [Node.js Security Best Practices (Official)](https://nodejs.org/en/learn/getting-started/security-best-practices)
*   [Nodejs-security.com Blog (OWASP-focused articles)](https://www.nodejs-security.com/blog/)

## V. GitHub Actions for GCP Deployment

*   [Deploy to Cloud Run Action](https://github.com/google-github-actions/deploy-cloudrun)
*   [Authenticate to GCP Action](https://github.com/google-github-actions/auth)

## VI. Other Key Topics & Discussions

*   **Twitch Developer Forums (discuss.dev.twitch.com):** Various threads discussing rate limits, API usage, and bot implementation challenges (e.g., threads on rate limits, moderator status detection, API errors).
*   **Stack Overflow:** Questions related to `tmi.js` event handling, Node.js asynchronous operations, API error handling patterns, EMA calculation in JavaScript, etc.
*   **LLM Context/Memory Management (Conceptual References):** Blogs and documentation from sources like LangChain, Pinecone, Vellum AI, Foojay.io discussing techniques for conversation summarization and retrieval-augmented generation (RAG).
*   **Rate Limiting Algorithms:** General resources (e.g., blogs from Radware, IO River, technical articles) explaining Token Bucket, Leaky Bucket, and adaptive rate limiting concepts.
*   **Secrets Management Comparisons:** Articles comparing Vault, AWS Secrets Manager, and Google Secret Manager (e.g., from Infisical, Wallarm).

