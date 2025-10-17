# IRC Leader Election Implementation

## Overview

This bot implements IRC leader election to ensure only one instance connects to Twitch IRC when running on Google Cloud Run with multiple instances. This prevents duplicate messages and connection conflicts.

## Architecture

### Leader Election

The leader election system uses Firestore as a distributed lock mechanism:

- **Lease Document**: `system/ircLeader` in Firestore
- **Heartbeat Interval**: 30 seconds
- **Lease TTL**: 120 seconds
- **Instance ID Format**: `{service}:{revision}:{randomSuffix}`

### Components

#### 1. `src/lib/leaderElection.js`

Core leader election module that handles:
- Acquiring and renewing the IRC connection lease
- Heartbeat mechanism to maintain leadership
- Automatic failover when leader becomes unhealthy
- Clean lease release on shutdown

#### 2. `src/bot.js` Integration

**Development Mode**:
- Skips leader election entirely
- Directly starts IRC subsystem
- Allows for faster local development

**Production Mode**:
- Initializes leader election on startup
- Waits for leadership before connecting to IRC
- Handles leadership transitions gracefully

### IRC Subsystem Functions

#### `startIrcSubsystem()`
Called when this instance acquires leadership (normal mode):
- Creates IRC client
- Attaches event listeners
- Connects to Twitch immediately
- Starts all IRC-dependent services (polling, sync, etc.)

#### `startIrcSubsystemLazyMode()`
Called when this instance acquires leadership (LAZY_CONNECT mode):
- Does NOT connect to IRC immediately
- Starts background services (stream polling, auto-chat, ad poller)
- Waits for EventSub webhook to trigger IRC connection
- Allows bot to scale to 0 when no streams are live

#### `stopIrcSubsystem()`
Called when this instance loses leadership:
- Disconnects IRC client (if connected)
- Cleans up listeners and intervals
- Stops all IRC-dependent services

## Deployment

### Cloud Build Configuration

The `cloudbuild.yaml` grants necessary IAM permissions:

```yaml
# Firestore/Datastore User role (for leader election)
roles/datastore.user

# Cloud Tasks Enqueuer role (for keep-alive)
roles/cloudtasks.enqueuer
```

### Environment Variables

- `K_SERVICE`: Cloud Run service name (auto-set)
- `K_REVISION`: Cloud Run revision ID (auto-set)
- `NODE_ENV`: Set to `production` for leader election mode
- `LAZY_CONNECT`: Set to `true` or `1` to enable lazy connect mode (allows scale-to-zero)

## How It Works

### On Startup (Production)

1. All instances start HTTP server immediately
2. All instances initialize core components (Firestore, Helix, etc.)
3. Leader election begins for each instance
4. First instance to acquire lease becomes leader
5. Leader instance starts IRC subsystem
6. Non-leader instances remain ready as hot standbys

### During Operation

- Leader sends heartbeat every 30 seconds
- If leader fails to renew lease (crash, network issue):
  - Lease expires after 120 seconds
  - Another instance acquires leadership
  - New leader starts IRC subsystem
- If leader gracefully shuts down:
  - Releases lease immediately
  - Another instance can acquire leadership instantly

### Leadership Transition

**Old Leader**:
1. Detects loss of lease
2. Calls `stopIrcSubsystem()`
3. Disconnects from IRC
4. Continues running as a standby

**New Leader**:
1. Acquires lease
2. Calls `startIrcSubsystem()`
3. Connects to IRC
4. Resumes bot operations

## LAZY_CONNECT Mode

When `LAZY_CONNECT=true`, the bot uses a cost-optimized mode:

### How It Works
1. Leader starts but doesn't connect to IRC
2. Background services run (stream polling, auto-chat)
3. EventSub webhooks notify when streams go live
4. IRC connection happens only when needed
5. Bot can scale to 0 when no streams are active

### Benefits
- **Cost Savings**: No instances running when no one is streaming
- **Fast Wake-Up**: EventSub triggers instant scaling and IRC connection
- **Smart Polling**: Detects already-live streams on startup

### Trade-offs
- Small delay (1-2s) when first stream goes live
- Requires EventSub webhooks to be configured
- Keep-alive tasks maintain at least one standby instance

## Benefits

1. **High Availability**: Automatic failover within 2 minutes of leader failure
2. **No Duplicate Messages**: Only one instance connects to IRC
3. **Graceful Scaling**: Cloud Run can scale instances without IRC conflicts
4. **Development Friendly**: Bypasses leader election in dev mode
5. **Cost Optimization**: LAZY_CONNECT mode allows scale-to-zero when idle

## Monitoring

Key log messages to monitor:

```
LeaderElection: Starting leader election loop
LeaderElection: Acquired leadership
LeaderElection: Lost leadership
ChatSage: Starting IRC subsystem (leader acquired)
ChatSage: Stopping IRC subsystem (leadership lost)
```

## Future Enhancements

- Add Pub/Sub for cross-instance communication (for features requiring coordination)
- Implement health checks for faster failover detection
- Add metrics for leadership duration and transitions
