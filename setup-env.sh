#!/bin/bash
set -euo pipefail

# setup-env.sh — Create a new OpenClaw environment (staging, dev, etc.)
#
# Usage: ./setup-env.sh <env-name> [gateway-port] [bridge-port]
#
# Example:
#   ./setup-env.sh staging 18791 18792
#   ./setup-env.sh dev 18793 18794
#
# This script will:
#   1. Create ~/.openclaw-<name>/ data directory
#   2. Copy production config as a base
#   3. Register a Matrix user @kay-<name>:matrix.local on Synapse
#   4. Log in to get a device-bound access token (required for E2EE)
#   5. Patch the config with the new Matrix credentials
#   6. Generate .env.<name> for docker-compose
#   7. Generate docker-compose.<name>.yml overlay

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SYNAPSE_HOST="${SYNAPSE_HOST:-http://192.168.1.168:8008}"
SYNAPSE_SERVER_NAME="${SYNAPSE_SERVER_NAME:-matrix.local}"
SYNAPSE_SHARED_SECRET="${SYNAPSE_SHARED_SECRET:-XFhHK7.6W&xB3#^8,,Epe*oJ.Nx*@r7SsG#qn4eqjqF,*xK+B;}"
PROD_CONFIG_DIR="${PROD_CONFIG_DIR:-$HOME/.openclaw}"
PROD_ENV_FILE="${PROD_ENV_FILE:-$SCRIPT_DIR/.env}"
BOT_PREFIX="${BOT_PREFIX:-kay}"

# --- Args ---
ENV_NAME="${1:?Usage: $0 <env-name> [gateway-port] [bridge-port]}"
GATEWAY_PORT="${2:-}"
BRIDGE_PORT="${3:-}"

# Derive defaults
DATA_DIR="$HOME/.openclaw-${ENV_NAME}"
BOT_USER="${BOT_PREFIX}-${ENV_NAME}"
MATRIX_USER_ID="@${BOT_USER}:${SYNAPSE_SERVER_NAME}"
DEVICE_ID="OPENCLAW_$(echo "$ENV_NAME" | tr '[:lower:]' '[:upper:]')"

# Auto-assign ports if not specified (find first unused starting at 18791)
if [ -z "$GATEWAY_PORT" ]; then
  GATEWAY_PORT=18791
  while ss -tlnp 2>/dev/null | grep -q ":${GATEWAY_PORT} " || \
        grep -rq "\"${GATEWAY_PORT}\"" "$SCRIPT_DIR"/.env.* 2>/dev/null; do
    GATEWAY_PORT=$((GATEWAY_PORT + 2))
  done
fi
if [ -z "$BRIDGE_PORT" ]; then
  BRIDGE_PORT=$((GATEWAY_PORT + 1))
fi

echo "=== Setting up OpenClaw environment: $ENV_NAME ==="
echo "  Data dir:     $DATA_DIR"
echo "  Matrix user:  $MATRIX_USER_ID"
echo "  Gateway port: $GATEWAY_PORT"
echo "  Bridge port:  $BRIDGE_PORT"
echo ""

# --- Step 1: Create data directory ---
if [ -d "$DATA_DIR" ]; then
  echo "WARNING: $DATA_DIR already exists."
  read -p "Overwrite config? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborting."
    exit 1
  fi
fi

mkdir -p "$DATA_DIR"/workspace
chmod 700 "$DATA_DIR"

# --- Step 2: Copy production config ---
if [ ! -f "$PROD_CONFIG_DIR/openclaw.json" ]; then
  echo "ERROR: Production config not found at $PROD_CONFIG_DIR/openclaw.json"
  exit 1
fi

cp "$PROD_CONFIG_DIR/openclaw.json" "$DATA_DIR/openclaw.json"
chmod 600 "$DATA_DIR/openclaw.json"
echo "Copied production config."

# --- Step 3: Register Matrix user ---
echo "Registering Matrix user: $MATRIX_USER_ID"

# Generate a random password
BOT_PASSWORD="$(openssl rand -base64 24)"

# Get a nonce from Synapse
NONCE=$(curl -s "${SYNAPSE_HOST}/_synapse/admin/v1/register" | python3 -c "import sys,json; print(json.load(sys.stdin)['nonce'])")

# Compute HMAC
MAC=$(printf '%s\0%s\0%s\0notadmin' "$NONCE" "$BOT_USER" "$BOT_PASSWORD" \
  | openssl dgst -sha1 -hmac "$SYNAPSE_SHARED_SECRET" | awk '{print $2}')

# Register
REG_RESULT=$(curl -s -X POST "${SYNAPSE_HOST}/_synapse/admin/v1/register" \
  -H "Content-Type: application/json" \
  -d "{
    \"nonce\": \"$NONCE\",
    \"username\": \"$BOT_USER\",
    \"password\": \"$BOT_PASSWORD\",
    \"admin\": false,
    \"mac\": \"$MAC\"
  }")

if echo "$REG_RESULT" | python3 -c "import sys,json; json.load(sys.stdin)['user_id']" &>/dev/null; then
  echo "Registered: $MATRIX_USER_ID"
elif echo "$REG_RESULT" | grep -q "User ID already taken"; then
  echo "User $MATRIX_USER_ID already exists, reusing."
else
  echo "WARNING: Registration response: $REG_RESULT"
  echo "Attempting login with existing user..."
fi

# --- Step 4: Log in to get device-bound access token ---
echo "Logging in to get device-bound token..."

LOGIN_RESULT=$(curl -s -X POST "${SYNAPSE_HOST}/_matrix/client/v3/login" \
  -H "Content-Type: application/json" \
  -d "{
    \"type\": \"m.login.password\",
    \"identifier\": {\"type\": \"m.id.user\", \"user\": \"$BOT_USER\"},
    \"password\": \"$BOT_PASSWORD\",
    \"device_id\": \"$DEVICE_ID\",
    \"initial_device_display_name\": \"OpenClaw Gateway ($ENV_NAME)\"
  }")

ACCESS_TOKEN=$(echo "$LOGIN_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null)
RESULT_DEVICE_ID=$(echo "$LOGIN_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['device_id'])" 2>/dev/null)

if [ -z "$ACCESS_TOKEN" ] || [ "$ACCESS_TOKEN" = "None" ]; then
  echo "ERROR: Failed to get access token."
  echo "Login result: $LOGIN_RESULT"
  echo ""
  echo "You may need to manually configure Matrix credentials in $DATA_DIR/openclaw.json"
  exit 1
fi

echo "Got access token for device: $RESULT_DEVICE_ID"

# --- Step 5: Patch config with Matrix credentials ---
python3 -c "
import json, sys

with open('$DATA_DIR/openclaw.json') as f:
    cfg = json.load(f)

cfg['channels']['matrix']['userId'] = '$MATRIX_USER_ID'
cfg['channels']['matrix']['accessToken'] = '$ACCESS_TOKEN'
cfg['channels']['matrix']['deviceId'] = '$RESULT_DEVICE_ID'

with open('$DATA_DIR/openclaw.json', 'w') as f:
    json.dump(cfg, f, indent=2)
    f.write('\n')
"
echo "Patched config with Matrix credentials."

# --- Step 6: Generate .env file ---
# Read shared secrets from production .env
GATEWAY_TOKEN=$(grep '^OPENCLAW_GATEWAY_TOKEN=' "$PROD_ENV_FILE" | cut -d= -f2-)
ANTHROPIC_KEY=$(grep '^ANTHROPIC_API_KEY=' "$PROD_ENV_FILE" | cut -d= -f2-)

cat > "$SCRIPT_DIR/.env.${ENV_NAME}" <<EOF
# OpenClaw ${ENV_NAME} environment
OPENCLAW_CONFIG_DIR=${DATA_DIR}
OPENCLAW_WORKSPACE_DIR=${DATA_DIR}/workspace
OPENCLAW_GATEWAY_PORT=${GATEWAY_PORT}
OPENCLAW_BRIDGE_PORT=${BRIDGE_PORT}
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_IMAGE=openclaw:local

OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN}
ANTHROPIC_API_KEY=${ANTHROPIC_KEY}

DEPLOY_WEBHOOK_URL=http://192.168.1.168:18795
DEPLOY_WEBHOOK_TOKEN=$(grep '^DEPLOY_WEBHOOK_TOKEN=' "$SCRIPT_DIR/.env.webhook" 2>/dev/null | cut -d= -f2- || echo "CHANGEME")
EOF
echo "Generated .env.${ENV_NAME}"

# --- Step 7: Generate compose overlay ---
cat > "$SCRIPT_DIR/docker-compose.${ENV_NAME}.yml" <<EOF
# OpenClaw ${ENV_NAME} instance
# Usage: docker compose -f docker-compose.yml -f docker-compose.${ENV_NAME}.yml --env-file .env.${ENV_NAME} up -d openclaw-gateway
services:
  openclaw-gateway:
    image: \${OPENCLAW_IMAGE:-openclaw:local}
    container_name: openclaw-${ENV_NAME}-gateway
    environment:
      HOME: /home/node
      TERM: xterm-256color
      OPENCLAW_GATEWAY_TOKEN: \${OPENCLAW_GATEWAY_TOKEN}
      ANTHROPIC_API_KEY: \${ANTHROPIC_API_KEY}
      CLAUDE_AI_SESSION_KEY: \${CLAUDE_AI_SESSION_KEY}
      CLAUDE_WEB_SESSION_KEY: \${CLAUDE_WEB_SESSION_KEY}
      CLAUDE_WEB_COOKIE: \${CLAUDE_WEB_COOKIE}
      DEPLOY_WEBHOOK_URL: \${DEPLOY_WEBHOOK_URL:-http://192.168.1.168:18795}
      DEPLOY_WEBHOOK_TOKEN: \${DEPLOY_WEBHOOK_TOKEN}
    volumes:
      - \${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
      - \${OPENCLAW_CONFIG_DIR}/openclaw.json:/home/node/.openclaw/openclaw.json:ro
      - \${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace
    ports:
      - "\${OPENCLAW_GATEWAY_PORT:-${GATEWAY_PORT}}:18789"
      - "\${OPENCLAW_BRIDGE_PORT:-${BRIDGE_PORT}}:18790"
    init: true
    restart: unless-stopped
    command:
      [
        "openclaw",
        "gateway",
        "--bind",
        "lan",
        "--port",
        "18789",
      ]
EOF
echo "Generated docker-compose.${ENV_NAME}.yml"

echo ""
echo "=== Done! ==="
echo ""
echo "To start:"
echo "  cd $SCRIPT_DIR"
echo "  docker compose -f docker-compose.yml -f docker-compose.${ENV_NAME}.yml --env-file .env.${ENV_NAME} up -d openclaw-gateway"
echo ""
echo "To message the bot:"
echo "  DM $MATRIX_USER_ID on Matrix"
echo ""
echo "Matrix credentials saved to: $DATA_DIR/openclaw.json"
echo "Bot password (save securely): $BOT_PASSWORD"
