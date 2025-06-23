# EventSub Integration for Zero-Instance Cloud Run

This document explains the EventSub integration that allows the ChatSage bot to scale to 0 instances on Google Cloud Run and automatically wake up when streamers go live.

## Overview

The EventSub integration subscribes to Twitch's `stream.online` events for all channels where the bot is installed. When a streamer goes live, Twitch sends a webhook to the bot's `/twitch/event` endpoint, which wakes up the Cloud Run instance and connects the bot to IRC.

## Components

### 1. EventSub Handler (`src/components/twitch/eventsub.js`)
- Verifies Twitch webhook signatures using HMAC-SHA256
- Handles webhook verification challenges
- Processes `stream.online` notifications
- Manages lazy IRC connection initialization

### 2. Subscription Management (`src/components/twitch/twitchSubs.js`)
- Creates EventSub subscriptions for channels
- Lists and deletes existing subscriptions
- Batch operations for all managed channels

### 3. Management Script (`scripts/manage-eventsub.js`)
- CLI tool for managing EventSub subscriptions
- Commands: list, subscribe-all, delete, delete-all

## Environment Variables

Add these to your Cloud Run environment:

```bash
TWITCH_EVENTSUB_SECRET=your_webhook_secret_here
PUBLIC_URL=https://your-service.a.run.app
LAZY_CONNECT=1
```

## Deployment Configuration

Update your Cloud Run deployment:

```bash
gcloud run deploy chatsage \
  --source=. \
  --region=us-central1 \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=1 \
  --set-env-vars TWITCH_EVENTSUB_SECRET=your_secret \
  --set-env-vars PUBLIC_URL=https://your-service.a.run.app \
  --set-env-vars LAZY_CONNECT=1
```

## Setup Process

1. **Deploy with EventSub support:**
   ```bash
   # Update environment variables and deploy
   gcloud run deploy chatsage --set-env-vars LAZY_CONNECT=1,TWITCH_EVENTSUB_SECRET=your_secret,PUBLIC_URL=https://your-service.a.run.app
   ```

2. **Subscribe channels to EventSub:**
   ```bash
   node scripts/manage-eventsub.js subscribe-all
   ```

3. **Verify subscriptions:**
   ```bash
   node scripts/manage-eventsub.js list
   ```

## How It Works

1. **Normal State:** Cloud Run instance scales to 0, no resources consumed
2. **Stream Goes Live:** Twitch sends webhook to `/twitch/event`
3. **Cold Start:** Cloud Run starts new instance (1-2 seconds)
4. **Bot Activation:** EventSub handler creates IRC client and connects
5. **Channel Join:** Bot joins the live streamer's channel
6. **Ready:** Bot is active and responds to chat (~3-4 seconds total)

## Testing

Test the webhook endpoint using Twitch CLI:

```bash
# Install Twitch CLI
# Configure with your app credentials
twitch event trigger stream-online -s

# Test specific broadcaster
twitch event trigger stream-online --broadcaster-user-id=123456 -s
```

## Monitoring

The bot logs EventSub events at INFO level:

```
📡 streamername just went live — ensuring bot is active...
EventSub triggered - initializing IRC connection...
IRC connection established from EventSub trigger
Joined channel #streamername via EventSub trigger
```

## Management Commands

```bash
# List all subscriptions
node scripts/manage-eventsub.js list

# Subscribe all managed channels
node scripts/manage-eventsub.js subscribe-all

# Delete specific subscription
node scripts/manage-eventsub.js delete <subscription-id>

# Delete all subscriptions
node scripts/manage-eventsub.js delete-all
```

## Security

- Webhook signatures are verified using TWITCH_EVENTSUB_SECRET
- Only authenticated Twitch requests are processed
- Failed signature verification returns 403

## Limitations

- Cold start time: 2-3 seconds (Cloud Run + IRC connect)
- First chat message might be missed if sent immediately after "Go Live"
- EventSub has a short retry window (few seconds)
- Maximum 1 instance to prevent duplicate IRC connections

## Cost Savings

With min-instances=0:
- **Before:** ~$30-50/month for always-on instance
- **After:** ~$5-10/month for actual usage only
- **Savings:** 70-80% reduction in hosting costs

## Troubleshooting

### Common Issues

1. **EventSub webhook fails verification**
   - Check TWITCH_EVENTSUB_SECRET matches subscription secret
   - Verify PUBLIC_URL is correct and accessible

2. **Bot doesn't wake up on stream**
   - Check EventSub subscriptions: `node scripts/manage-eventsub.js list`
   - Verify webhook endpoint is reachable: `curl https://your-service.a.run.app/twitch/event`

3. **IRC connection fails on wake-up**
   - Check Twitch credentials and refresh token validity
   - Verify LAZY_CONNECT=1 is set in environment

### Logs to Check

```bash
# Cloud Run logs
gcloud logs read --service=chatsage --limit=50

# Filter for EventSub events
gcloud logs read --service=chatsage --filter="📡" --limit=20
```