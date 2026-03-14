#!/usr/bin/env bash
# scripts/dev-tunnel.sh
# Starts ngrok + the bot with automatic PUBLIC_URL patching.
# Usage: npm run dev:tunnel  (or: bash scripts/dev-tunnel.sh)

set -euo pipefail

PORT="${PORT:-8080}"
ENV_FILE=".env"
ENV_BACKUP=".env.bak"
NGROK_API="http://127.0.0.1:4040/api/tunnels"

# ── Cleanup on exit ─────────────────────────────────────────────────
cleanup() {
    echo ""
    echo "🧹 Cleaning up..."

    # Kill the bot if running
    if [[ -n "${BOT_PID:-}" ]] && kill -0 "$BOT_PID" 2>/dev/null; then
        kill "$BOT_PID" 2>/dev/null || true
        wait "$BOT_PID" 2>/dev/null || true
        echo "   ✓ Bot stopped"
    fi

    # Kill ngrok
    if [[ -n "${NGROK_PID:-}" ]] && kill -0 "$NGROK_PID" 2>/dev/null; then
        kill "$NGROK_PID" 2>/dev/null || true
        wait "$NGROK_PID" 2>/dev/null || true
        echo "   ✓ ngrok stopped"
    fi

    # Delete EventSub subscriptions pointing to this ngrok tunnel
    if [[ -n "${NGROK_URL:-}" ]]; then
        echo "   🗑️  Cleaning up EventSub subscriptions for $NGROK_URL..."
        node --input-type=module <<JSEOF 2>/dev/null && echo "   ✓ EventSub subscriptions cleaned up" || echo "   ⚠️  Could not clean up EventSub subscriptions (run scripts/cleanup-dev-subs.js manually)"
import config from './src/config/index.js';
import axios from 'axios';
const ngrokUrl = '${NGROK_URL}';
try {
    const tokenRes = await axios.post('https://id.twitch.tv/oauth2/token', null, {
        params: { client_id: config.twitch.clientId, client_secret: config.twitch.clientSecret, grant_type: 'client_credentials' }
    });
    const token = tokenRes.data.access_token;
    const headers = { 'Client-ID': config.twitch.clientId, 'Authorization': \`Bearer \${token}\` };
    const res = await axios.get('https://api.twitch.tv/helix/eventsub/subscriptions?first=100', { headers });
    const toDelete = (res.data.data || []).filter(s => s.transport?.callback?.startsWith(ngrokUrl));
    for (const sub of toDelete) {
        await axios.delete(\`https://api.twitch.tv/helix/eventsub/subscriptions?id=\${sub.id}\`, { headers });
        process.stdout.write(\`      Deleted \${sub.type} for broadcaster \${sub.condition?.broadcaster_user_id}\\n\`);
    }
    if (toDelete.length === 0) process.stdout.write('      No subscriptions to clean up\\n');
} catch (e) {
    process.stdout.write(\`      Error: \${e.response?.data?.message || e.message}\\n\`);
    process.exit(1);
}
JSEOF
    fi

    # Restore .env
    if [[ -f "$ENV_BACKUP" ]]; then
        mv "$ENV_BACKUP" "$ENV_FILE"
        echo "   ✓ .env restored"
    fi

    echo "👋 Done."
}
trap cleanup EXIT INT TERM

# ── Pre-flight checks ───────────────────────────────────────────────
if ! command -v ngrok &>/dev/null; then
    echo "❌ ngrok is not installed. Install it with: brew install ngrok"
    exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
    echo "❌ No .env file found. Copy .env.example to .env and fill in your values."
    exit 1
fi

# ── Start ngrok ──────────────────────────────────────────────────────
echo "🚀 Starting ngrok on port $PORT..."
ngrok http "$PORT" --log=stderr > /dev/null 2>&1 &
NGROK_PID=$!

# Wait for ngrok to be ready
echo -n "⏳ Waiting for tunnel"
for i in $(seq 1 20); do
    sleep 0.5
    if curl -s "$NGROK_API" > /dev/null 2>&1; then
        echo " ✓"
        break
    fi
    echo -n "."
    if [[ $i -eq 20 ]]; then
        echo ""
        echo "❌ Timed out waiting for ngrok. Is your auth token configured?"
        echo "   Run: ngrok config add-authtoken <your-token>"
        exit 1
    fi
done

# Extract the public URL
NGROK_URL=$(curl -s "$NGROK_API" | python3 -c "
import sys, json
tunnels = json.load(sys.stdin)['tunnels']
for t in tunnels:
    if t['proto'] == 'https':
        print(t['public_url'])
        break
" 2>/dev/null)

if [[ -z "$NGROK_URL" ]]; then
    echo "❌ Could not extract ngrok public URL."
    exit 1
fi

echo "🌐 Tunnel URL: $NGROK_URL"
echo "📡 Webhook endpoint: $NGROK_URL/twitch/event"
echo ""

# ── Patch .env ───────────────────────────────────────────────────────
cp "$ENV_FILE" "$ENV_BACKUP"

if grep -q "^PUBLIC_URL=" "$ENV_FILE"; then
    # Replace existing PUBLIC_URL line
    sed -i '' "s|^PUBLIC_URL=.*|PUBLIC_URL=$NGROK_URL|" "$ENV_FILE"
else
    # Append if not present
    echo "PUBLIC_URL=$NGROK_URL" >> "$ENV_FILE"
fi

echo "✅ PUBLIC_URL set to $NGROK_URL in .env"
echo ""

# ── Start the bot ────────────────────────────────────────────────────
echo "🤖 Starting WildcatSage..."
echo "─────────────────────────────────────────────────────"
node src/bot.js &
BOT_PID=$!

# Wait for the bot process (keeps the script alive until Ctrl+C)
wait "$BOT_PID"
