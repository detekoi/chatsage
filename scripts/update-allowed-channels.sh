#!/bin/bash

# This script updates the 'allowed-channels' secret in Google Cloud Secret Manager
# with the contents of 'channels.txt'.

# --- Configuration ---
PROJECT_ID="streamsage-bot"
SECRET_NAME="allowed-channels"
REGION="us-central1"
CHANNELS_FILE="channels.txt"

# --- Script Body ---

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null
then
    echo "gcloud CLI could not be found. Please install it and configure it."
    exit 1
fi

# Check if the channels file exists
if [ ! -f "$CHANNELS_FILE" ]; then
    echo "Error: $CHANNELS_FILE not found."
    exit 1
fi

# Read channels from the file, filter out empty lines, and join them with a comma
CHANNELS=$(grep -v '^$' "$CHANNELS_FILE" | paste -sd, -)

if [ -z "$CHANNELS" ]; then
    echo "No channels found in $CHANNELS_FILE. The secret will not be updated."
    exit 1
fi

echo "The following channels will be set in the secret:"
echo "$CHANNELS"
echo ""

# Add a new version to the secret with the updated channel list
echo "Updating secret: $SECRET_NAME in project: $PROJECT_ID..."
echo -n "$CHANNELS" | gcloud secrets versions add "$SECRET_NAME" --data-file=- --project="$PROJECT_ID" --quiet

if [ $? -eq 0 ]; then
    echo "Secret '$SECRET_NAME' updated successfully."
else
    echo "Error updating secret '$SECRET_NAME'."
    exit 1
fi

# The Cloud Run service 'webui' should be configured to use this secret.
# A new revision will be created automatically if the service is configured
# to use the 'latest' version of the secret.
echo "The 'webui' service in '$REGION' will pick up the new secret version on its next instance start."
