#!/usr/bin/env bash
set -Eeuo pipefail

# Portable Cloud Run deploy script mirroring .github/workflows/deploy-cloud-run.yml
# Usage:
#   scripts/deploy-cloud-run.sh [--project PROJECT_ID] [--region REGION] [--service NAME] [--source DIR]
# Environment overrides (match GH Actions defaults where sensible):
#   GCP_PROJECT_ID, GCP_REGION, CLOUD_RUN_SERVICE_NAME, SOURCE_DIR, ALLOW_UNAUTH, MIN_INSTANCES
#   NODE_ENV, LOG_LEVEL, PINO_PRETTY_LOGGING, TWITCH_BOT_USERNAME, TWITCH_CHANNELS_SECRET_NAME,
#   GEMINI_MODEL_ID, STREAM_INFO_FETCH_INTERVAL_SECONDS, PUBLIC_URL, LAZY_CONNECT,
#   TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME, KEEP_ALIVE_QUEUE, GOOGLE_CLOUD_PROJECT,
#   WEBUI_BASE_URL, WEBUI_INTERNAL_TOKEN
# Secret mappings (Secret Manager secret ids; can override):
#   GEMINI_API_KEY_SECRET, TWITCH_CLIENT_ID_SECRET, TWITCH_CLIENT_SECRET_SECRET, TWITCH_EVENTSUB_SECRET_SECRET

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
Deploy to Cloud Run

Options:
  --project ID       GCP project id (default: env GCP_PROJECT_ID or streamsage-bot)
  --region REGION    Region (default: env GCP_REGION or us-central1)
  --service NAME     Cloud Run service name (default: env CLOUD_RUN_SERVICE_NAME or chatsage)
  --source DIR       Source directory to build from (default: env SOURCE_DIR or .)

Examples:
  scripts/deploy-cloud-run.sh
  scripts/deploy-cloud-run.sh --project my-proj --region us-central1 --service chatsage
USAGE
  exit 0
fi

# Defaults (override via env or flags)
PROJECT_ID=${GCP_PROJECT_ID:-streamsage-bot}
REGION=${GCP_REGION:-us-central1}
SERVICE=${CLOUD_RUN_SERVICE_NAME:-chatsage}
SOURCE_DIR=${SOURCE_DIR:-.}
ALLOW_UNAUTH=${ALLOW_UNAUTH:-true}
MIN_INSTANCES=${MIN_INSTANCES:-0}

# Parse simple flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT_ID="$2"; shift 2;;
    --region) REGION="$2"; shift 2;;
    --service) SERVICE="$2"; shift 2;;
    --source) SOURCE_DIR="$2"; shift 2;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done

# Label with commit sha if available
COMMIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "local")

# Env var defaults (mirror GH Actions)
NODE_ENV=${NODE_ENV:-production}
LOG_LEVEL=${LOG_LEVEL:-info}
PINO_PRETTY_LOGGING=${PINO_PRETTY_LOGGING:-false}
TWITCH_BOT_USERNAME=${TWITCH_BOT_USERNAME:-ChatSageBot}
TWITCH_CHANNELS_SECRET_NAME=${TWITCH_CHANNELS_SECRET_NAME:-projects/907887386166/secrets/twitch-channels/versions/latest}
GEMINI_MODEL_ID=${GEMINI_MODEL_ID:-gemini-2.5-flash-lite}
STREAM_INFO_FETCH_INTERVAL_SECONDS=${STREAM_INFO_FETCH_INTERVAL_SECONDS:-120}
# PUBLIC_URL should ideally be the Cloud Run URL; if not provided, we will deploy without it set.
PUBLIC_URL=${PUBLIC_URL:-}
LAZY_CONNECT=${LAZY_CONNECT:-true}
TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME=${TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME:-projects/907887386166/secrets/TWITCH_BOT_REFRESH_TOKEN/versions/latest}
KEEP_ALIVE_QUEUE=${KEEP_ALIVE_QUEUE:-self-ping}
GOOGLE_CLOUD_PROJECT=${GOOGLE_CLOUD_PROJECT:-$PROJECT_ID}
WEBUI_BASE_URL=${WEBUI_BASE_URL:-https://webui-zpqjdsguqa-uc.a.run.app}
WEBUI_INTERNAL_TOKEN=${WEBUI_INTERNAL_TOKEN:-projects/907887386166/secrets/webui-internal-token}

# Secret Manager secret ids used for --set-secrets
GEMINI_API_KEY_SECRET=${GEMINI_API_KEY_SECRET:-STREAM_SAGE_GEMINI_API_KEY}
TWITCH_CLIENT_ID_SECRET=${TWITCH_CLIENT_ID_SECRET:-STREAM_SAGE_TWITCH_CLIENT_ID}
TWITCH_CLIENT_SECRET_SECRET=${TWITCH_CLIENT_SECRET_SECRET:-STREAM_SAGE_TWITCH_CLIENT_SECRET}
TWITCH_EVENTSUB_SECRET_SECRET=${TWITCH_EVENTSUB_SECRET_SECRET:-twitch-eventsub-secret}

# Build env var string
ENV_VARS=(
  "NODE_ENV=$NODE_ENV"
  "LOG_LEVEL=$LOG_LEVEL"
  "PINO_PRETTY_LOGGING=$PINO_PRETTY_LOGGING"
  "TWITCH_BOT_USERNAME=$TWITCH_BOT_USERNAME"
  "TWITCH_CHANNELS_SECRET_NAME=$TWITCH_CHANNELS_SECRET_NAME"
  "GEMINI_MODEL_ID=$GEMINI_MODEL_ID"
  "STREAM_INFO_FETCH_INTERVAL_SECONDS=$STREAM_INFO_FETCH_INTERVAL_SECONDS"
  # PUBLIC_URL may be empty on first deploy; warn if so
  "PUBLIC_URL=$PUBLIC_URL"
  "LAZY_CONNECT=$LAZY_CONNECT"
  "TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME=$TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME"
  "KEEP_ALIVE_QUEUE=$KEEP_ALIVE_QUEUE"
  "GOOGLE_CLOUD_PROJECT=$GOOGLE_CLOUD_PROJECT"
  "WEBUI_BASE_URL=$WEBUI_BASE_URL"
  "WEBUI_INTERNAL_TOKEN=$WEBUI_INTERNAL_TOKEN"
)

if [[ -z "$PUBLIC_URL" ]]; then
  echo "[warn] PUBLIC_URL is empty. You can set it after the first deploy to your Cloud Run URL."
fi

# Join env vars with commas
join_by_comma() {
  local IFS=','; echo "$*";
}
ENV_ARG=$(join_by_comma "${ENV_VARS[@]}")

SECRETS_ARG="GEMINI_API_KEY=${GEMINI_API_KEY_SECRET}:latest,TWITCH_CLIENT_ID=${TWITCH_CLIENT_ID_SECRET}:latest,TWITCH_CLIENT_SECRET=${TWITCH_CLIENT_SECRET_SECRET}:latest,TWITCH_EVENTSUB_SECRET=${TWITCH_EVENTSUB_SECRET_SECRET}:latest"

echo "[info] Deploying service '$SERVICE' to region '$REGION' in project '$PROJECT_ID' from '$SOURCE_DIR'..."

# Ensure gcloud is targeting the right project
gcloud config set project "$PROJECT_ID" >/dev/null

ALLOW_FLAG=("--no-allow-unauthenticated")
if [[ "$ALLOW_UNAUTH" == "true" || "$ALLOW_UNAUTH" == "1" ]]; then
  ALLOW_FLAG=("--allow-unauthenticated")
fi

DEPLOYED_URL=$(gcloud run deploy "$SERVICE" \
  --source "$SOURCE_DIR" \
  --region "$REGION" \
  "${ALLOW_FLAG[@]}" \
  --min-instances "$MIN_INSTANCES" \
  --set-env-vars "$ENV_ARG" \
  --set-secrets "$SECRETS_ARG" \
  --labels "managed-by=local,commit-sha=$COMMIT_SHA" \
  --format="get(status.url)")

echo "[info] Deployed URL: $DEPLOYED_URL"

if [[ -z "$PUBLIC_URL" ]]; then
  echo "[hint] Consider setting PUBLIC_URL to '$DEPLOYED_URL' and redeploy:"
  echo "       PUBLIC_URL=$DEPLOYED_URL scripts/deploy-cloud-run.sh --project $PROJECT_ID --region $REGION --service $SERVICE"
fi


