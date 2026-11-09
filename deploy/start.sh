#!/usr/bin/env bash
# Local all-in-one supervisor: restarts the app (and keeps the tunnel up).
# Usage: ./deploy/start.sh
set -u
cd "$(dirname "$0")/.."
export PORT="${PORT:-8090}"
export DATA_DIR="${DATA_DIR:-$PWD/data}"
mkdir -p "$DATA_DIR"

echo "[whalechat] starting app on :$PORT (data: $DATA_DIR)"
node server.js &
APP=$!

if command -v cloudflared >/dev/null 2>&1 && [ "${TUNNEL:-0}" = "1" ]; then
  echo "[whalechat] starting Cloudflare tunnel…"
  cloudflared tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate &
  TUNNEL_PID=$!
  trap 'kill $APP $TUNNEL_PID 2>/dev/null' INT TERM
else
  trap 'kill $APP 2>/dev/null' INT TERM
fi

while true; do
  if ! kill -0 "$APP" 2>/dev/null; then
    echo "[whalechat] app stopped — restarting in 2s"
    sleep 2
    node server.js &
    APP=$!
  fi
  sleep 5
done
