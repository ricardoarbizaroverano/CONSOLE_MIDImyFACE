#!/bin/zsh
set -euo pipefail

ROOT_DIR="/Users/ricardoarbiza/Documents/MIDImyFACE-githubRepo"
CONSOLE_DIR="$ROOT_DIR/CONSOLE_MIDImyFACE"
RELAY_DIR="$ROOT_DIR/midimyface-relay"

RELAY_PORT="${RELAY_PORT:-11001}"
export TEST_ADMIN_USERNAME="${TEST_ADMIN_USERNAME:-admin}"
export TEST_ADMIN_PASSWORD="${TEST_ADMIN_PASSWORD:-test123}"
export RELAY_JOIN_TOKEN_SECRET="${RELAY_JOIN_TOKEN_SECRET:-dev-relay-secret-change-me}"
export INVITE_TOKEN_SECRET="${INVITE_TOKEN_SECRET:-dev-invite-secret-change-me}"
export AUTH_TOKEN_SECRET="${AUTH_TOKEN_SECRET:-dev-auth-secret-change-me}"
export MIDIMYFACE_JOIN_URL="http://localhost:5500"
export PUBLIC_BASE_URL="http://127.0.0.1:${RELAY_PORT}"
# Both Console API + WebSocket relay now run from the same process
export CONSOLE_BASE_URL="http://127.0.0.1:${RELAY_PORT}"
export RELAY_WS_URL="ws://127.0.0.1:${RELAY_PORT}/ws"

cd "$RELAY_DIR"
PORT="$RELAY_PORT" \
  TEST_ADMIN_USERNAME="$TEST_ADMIN_USERNAME" \
  TEST_ADMIN_PASSWORD="$TEST_ADMIN_PASSWORD" \
  RELAY_JOIN_TOKEN_SECRET="$RELAY_JOIN_TOKEN_SECRET" \
  INVITE_TOKEN_SECRET="$INVITE_TOKEN_SECRET" \
  AUTH_TOKEN_SECRET="$AUTH_TOKEN_SECRET" \
  MIDIMYFACE_JOIN_URL="$MIDIMYFACE_JOIN_URL" \
  PUBLIC_BASE_URL="$PUBLIC_BASE_URL" \
  ALLOWED_ORIGINS='*' \
  node ./server.js >/tmp/mmf_relay_phase1.log 2>&1 &
RELAY_PID=$!

cleanup() {
  kill "$RELAY_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

sleep 1
cd "$CONSOLE_DIR"
node ./scripts/phase1-local-test.mjs
