# Observer-Actor Architecture Plan

## Current Problem

The bot is shutting down (receiving SIGTERM) even when streams are live because:

1. **Keep-alive only starts from EventSub webhooks**, not from stream poller
2. When a stream is already live at startup, poller detects it but keep-alive never starts
3. Without keep-alive pings, Cloud Run shuts down the instance after ~15 minutes

**Example from logs (2025-11-29 11:16 PST)**:
- runnerbean36 was live and bot was receiving chat
- No keep-alive pings were being sent
- Bot received SIGTERM and shut down
- Root cause: runnerbean36 was already live when bot started, so EventSub never fired

## Proposed Observer-Actor Architecture

### Core Principle
**Observer** = Detects state
**Actor** = Responds to state changes

The LifecycleManager should be the **single orchestrator** that:
1. Observes stream state (from poller + EventSub)
2. Decides what actors should do
3. Triggers actor responses

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                  OBSERVER LAYER                          │
│              (Detects reality)                           │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  ┌──────────────────┐    ┌─────────────────────┐        │
│  │ Stream Info      │    │ EventSub            │        │
│  │ Poller           │    │ Webhook Handler     │        │
│  │                  │    │                     │        │
│  │ • Polls Twitch   │    │ • stream.online     │        │
│  │ • Every 2 min    │    │ • stream.offline    │        │
│  │ • Gets live      │    │ • Real-time events  │        │
│  │   streams        │    │                     │        │
│  └────────┬─────────┘    └──────────┬──────────┘        │
│           │                         │                    │
│           └────────┐      ┌─────────┘                    │
│                    ▼      ▼                              │
│           ┌─────────────────────────┐                    │
│           │  LifecycleManager       │                    │
│           │  (Single Source of      │                    │
│           │   Truth)                │                    │
│           │                         │                    │
│           │  • activeStreams: Set   │                    │
│           │  • onStreamStatusChange()│                   │
│           │  • reassessConnectionState()│                │
│           └────────┬────────────────┘                    │
└────────────────────┼─────────────────────────────────────┘
                     │
                     │ Notifies actors
                     │
┌────────────────────┼─────────────────────────────────────┐
│                    ▼           ACTOR LAYER               │
│              (Responds to state)                         │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  ┌──────────────────────┐    ┌────────────────────────┐ │
│  │ IRC Actor            │    │ Keep-Alive Actor       │ │
│  │                      │    │                        │ │
│  │ • Connect when       │    │ • Start pings when     │ │
│  │   streams > 0        │    │   streams > 0          │ │
│  │ • Disconnect when    │    │ • Stop pings when      │ │
│  │   streams == 0       │    │   streams == 0         │ │
│  │   (if LAZY_CONNECT)  │    │                        │ │
│  │                      │    │ • Self-scheduling      │ │
│  │ • Join/part channels │    │   (each ping schedules │ │
│  │   as needed          │    │    the next one)       │ │
│  └──────────────────────┘    └────────────────────────┘ │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

## Implementation Plan

### 1. Create `KeepAliveActor` (NEW)

**File**: `src/services/KeepAliveActor.js`

```javascript
class KeepAliveActor {
    constructor() {
        this.keepAliveTaskName = null;
        this.isActive = false;
    }

    /**
     * Start keep-alive pings
     * Called by LifecycleManager when first stream goes live
     */
    async start() {
        if (this.isActive) {
            logger.debug('Keep-alive already active');
            return;
        }

        logger.info('Keep-alive: Starting pings');
        this.isActive = true;
        await this.schedulePing();
    }

    /**
     * Stop keep-alive pings
     * Called by LifecycleManager when all streams end
     */
    async stop() {
        if (!this.isActive) {
            logger.debug('Keep-alive already stopped');
            return;
        }

        logger.info('Keep-alive: Stopping pings');
        this.isActive = false;

        if (this.keepAliveTaskName) {
            await deleteTask(this.keepAliveTaskName);
            this.keepAliveTaskName = null;
        }
    }

    /**
     * Handle a keep-alive ping (called by /keep-alive endpoint)
     * This verifies streams are still live and schedules next ping
     */
    async handlePing() {
        if (!this.isActive) {
            logger.warn('Keep-alive ping received but actor is not active');
            return;
        }

        logger.info('Keep-alive ping received');

        // Verify streams are still live
        const lifecycle = LifecycleManager.get();
        const activeStreams = lifecycle.getActiveStreams();

        if (activeStreams.length > 0) {
            logger.info(`Keep-alive check passed: ${activeStreams.length} active streams`);
            await this.schedulePing();
        } else {
            logger.warn('Keep-alive check failed: No active streams');
            await this.stop();
        }
    }

    /**
     * Schedule the next ping
     */
    async schedulePing() {
        try {
            this.keepAliveTaskName = await scheduleNextKeepAlivePing(60); // 1 minute
        } catch (error) {
            logger.error({ err: error }, 'Failed to schedule keep-alive ping');
        }
    }
}
```

### 2. Enhance `LifecycleManager`

**File**: `src/services/LifecycleManager.js`

Add keep-alive actor management:

```javascript
class LifecycleManager {
    constructor() {
        this.activeStreams = new Set();
        this.isMonitoring = false;
        this.streamInfoIntervalId = null;
        this.channelChangeListener = null;
        this.keepAliveActor = new KeepAliveActor();  // NEW
    }

    /**
     * Called by EventSub or Poller when a stream goes online/offline.
     */
    async onStreamStatusChange(channel, isLive) {
        const login = channel.toLowerCase();
        const wasLive = this.activeStreams.has(login);
        const hadStreams = this.activeStreams.size > 0;

        if (isLive) {
            this.activeStreams.add(login);
            if (!wasLive) logger.info(`LifecycleManager: Stream ${login} went ONLINE.`);
        } else {
            this.activeStreams.delete(login);
            if (wasLive) logger.info(`LifecycleManager: Stream ${login} went OFFLINE.`);
        }

        const hasStreams = this.activeStreams.size > 0;

        // Trigger actor responses
        await this.reassessConnectionState();

        // NEW: Manage keep-alive actor
        if (!hadStreams && hasStreams) {
            // First stream went live
            await this.keepAliveActor.start();
        } else if (hadStreams && !hasStreams) {
            // Last stream went offline
            await this.keepAliveActor.stop();
        }
    }
}
```

### 3. Update EventSub Handler

**File**: `src/components/twitch/eventsub.js`

**REMOVE** keep-alive management (lines 14-18, 339-346):
```javascript
// DELETE THESE:
let keepAliveTaskName = null;
let consecutiveFailedChecks = 0;
const MAX_FAILED_CHECKS = 3;
const CHAT_ACTIVITY_THRESHOLD = 5 * 60 * 1000;

// DELETE THIS:
if (lifecycle.getActiveStreams().length === 1 && !keepAliveTaskName) {
    logger.info('First stream went live - starting keep-alive pings');
    keepAliveTaskName = await scheduleNextKeepAlivePing(60);
}
```

**SIMPLIFY** `handleKeepAlivePing()`:
```javascript
export async function handleKeepAlivePing() {
    const lifecycle = LifecycleManager.get();
    await lifecycle.keepAliveActor.handlePing();
}
```

### 4. Update Health Server

**File**: `src/server/healthServer.js`

No changes needed - already calls `handleKeepAlivePing()`

## Benefits of This Architecture

### 1. **Single Source of Truth**
- LifecycleManager is the **only** place that tracks active streams
- All observers feed into it
- All actors respond to it

### 2. **No More Race Conditions**
- Keep-alive starts when `activeStreams.size` goes from 0→1
- Doesn't matter if it's from EventSub or poller
- Always consistent

### 3. **Clear Separation of Concerns**
```
Observers:  "I see a stream is live"
Manager:    "I track all live streams"
Actors:     "I respond to the manager's state"
```

### 4. **Easier Testing**
- Mock the LifecycleManager
- Test actors independently
- Test observers independently

### 5. **Easier Debugging**
- One place to check stream state
- Clear logs: "Stream went ONLINE" → "Keep-alive starting"
- No scattered state across files

## Migration Steps

1. ✅ Create `KeepAliveActor.js`
2. ✅ Add keep-alive actor to `LifecycleManager`
3. ✅ Update `LifecycleManager.onStreamStatusChange()` to manage actor
4. ✅ Simplify `handleKeepAlivePing()` in `eventsub.js`
5. ✅ Remove keep-alive state from `eventsub.js`
6. ✅ Test with already-live stream at startup
7. ✅ Test with EventSub webhook triggering stream online
8. ✅ Test graceful shutdown when all streams end

## Testing Scenarios

### Scenario 1: Stream Already Live at Startup
```
1. runnerbean36 is live
2. Bot starts → Stream info poller runs
3. Poller detects runnerbean36 live
4. LifecycleManager.onStreamStatusChange("runnerbean36", true)
5. activeStreams: 0 → 1
6. KeepAliveActor.start() ← NEW!
7. Keep-alive pings begin
8. Bot stays alive ✅
```

### Scenario 2: Stream Goes Live via EventSub
```
1. Bot running, no streams
2. EventSub webhook: stream.online for pedroisworking
3. LifecycleManager.onStreamStatusChange("pedroisworking", true)
4. activeStreams: 0 → 1
5. KeepAliveActor.start()
6. Keep-alive pings begin
7. Bot stays alive ✅
```

### Scenario 3: All Streams End
```
1. Bot running, 2 streams active
2. Stream 1 ends (EventSub or verified by poller)
3. LifecycleManager.onStreamStatusChange(stream1, false)
4. activeStreams: 2 → 1
5. Keep-alive continues
6. Stream 2 ends
7. LifecycleManager.onStreamStatusChange(stream2, false)
8. activeStreams: 1 → 0
9. KeepAliveActor.stop() ← Stops pings
10. Bot scales down after ~15 min ✅
```

## Files to Change

| File | Changes | LOC |
|------|---------|-----|
| `src/services/KeepAliveActor.js` | **NEW FILE** | ~100 |
| `src/services/LifecycleManager.js` | Add keep-alive actor, update onStreamStatusChange | +15 |
| `src/components/twitch/eventsub.js` | Remove keep-alive state, simplify handleKeepAlivePing | -180 |
| Total | | -65 LOC |

**Net result**: Simpler, more reliable code with **fewer lines**!
