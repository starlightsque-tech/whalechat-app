#!/usr/bin/env bash
# WhaleChat keepalive — safe to run from cron every minute/two minutes.
#   * restarts server.js when it is unhealthy
#   * restarts the Cloudflare quick tunnel when enabled (TUNNEL=1)
#   * trims its own log
# Cron:
#   */2 * * * * /opt/whalechat/deploy/keepalive.sh >> /var/log/whalechat-keepalive.log 2>&1
set -u

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
PORT="${PORT:-8090}"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
LOG="${KEEPALIVE_LOG:-$DATA_DIR/keepalive.log}"
NODE_BIN="${NODE_BIN:-$(command -v node || echo /usr/bin/node)}"
TUNNEL="${TUNNEL:-0}"
TUNNEL_LOG="${TUNNEL_LOG:-$DATA_DIR/tunnel.log}"
PUBLIC_URL="${PUBLIC_URL:-}"

mkdir -p "$DATA_DIR"
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

# --- keep the log small (cron runs forever) ---------------------------------
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  tail -n 400 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
fi

# --- 1. server health -------------------------------------------------------
healthy=0
if command -v curl >/dev/null 2>&1; then
  body="$(curl -fsS -m 5 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
  case "$body" in *'"app":"whalechat"'*) healthy=1 ;; esac
else
  (echo > "/dev/tcp/127.0.0.1/$PORT") >/dev/null 2>&1 && healthy=1
fi

if [ "$healthy" != "1" ]; then
  say "server unhealthy on :$PORT — restarting"
  # kill whatever is listening on the app port (works regardless of how it was launched)
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "$PORT/tcp" 2>/dev/null || true
  else
    for pid in $(ss -ltnp 2>/dev/null | awk -v p=":$PORT" '$4 ~ p' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
      [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    done
  fi
  sleep 1
  ( cd "$APP_DIR" && PORT="$PORT" DATA_DIR="$DATA_DIR" PUBLIC_URL="$PUBLIC_URL" \
      NODE_PATH="${NODE_PATH:-$APP_DIR/node_modules}" NODE_ENV=production \
      nohup "$NODE_BIN" "$APP_DIR/server.js" >> "$DATA_DIR/server.out" 2>&1 & )
  sleep 3
  if curl -fsS -m 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    say "server restarted OK"
  else
    say "server restart FAILED — check $DATA_DIR/server.out"
  fi
else
  say "server healthy"
fi

# --- 2. optional quick tunnel ----------------------------------------------
if [ "$TUNNEL" = "1" ] && command -v cloudflared >/dev/null 2>&1; then
  if ! pgrep -f "cloudflared tunnel --url http://127.0.0.1:$PORT" >/dev/null 2>&1; then
    say "tunnel down — starting a new quick tunnel"
    nohup cloudflared tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate >> "$TUNNEL_LOG" 2>&1 &
    sleep 8
    url="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" | tail -1)"
    [ -n "$url" ] && say "tunnel URL: $url (update PUBLIC_URL to make it permanent)"
  fi
fi

# --- 3. optional deep check of the public URL ------------------------------
if [ -n "$PUBLIC_URL" ] && command -v curl >/dev/null 2>&1; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 12 "$PUBLIC_URL/api/health" 2>/dev/null || echo 000)"
  [ "$code" = "200" ] || say "public health check returned $code"
fi
