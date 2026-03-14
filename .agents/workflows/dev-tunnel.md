---
description: Start a local dev environment with ngrok tunnel for Twitch EventSub testing
---

# Local Dev Tunnel

Run the bot locally with a public ngrok URL so Twitch EventSub webhooks reach your machine.

## Quick Start

// turbo
1. Run the dev tunnel:
```bash
npm run dev:tunnel
```

## What It Does

1. Starts ngrok to tunnel port 8080
2. Extracts the public HTTPS URL from ngrok's local API
3. Patches `PUBLIC_URL` in `.env` with the ngrok URL (backs up to `.env.bak`)
4. Starts the bot — EventSub subscriptions are auto-created on boot
5. On exit (Ctrl+C), restores the original `.env`

## Prerequisites

- ngrok installed and auth token configured (`ngrok config add-authtoken <token>`)
- A populated `.env` file (copy from `.env.example`)

## Notes

- The ngrok URL changes every time you restart (free tier). EventSub subscriptions are re-registered on each bot startup.
- **On exit (Ctrl+C), the script automatically deletes all EventSub subscriptions pointing to the ngrok URL** to prevent stale subscriptions from firing production events.
- If the bot crashes but ngrok is still running, just Ctrl+C and re-run.
- The original `.env` is always restored on exit via the `.env.bak` backup.
