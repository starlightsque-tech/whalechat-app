#!/usr/bin/env bash
# Deploy WhaleChat 3.63.0 — Cloudflare Worker (API) + Pages (app).
#   CLOUDFLARE_API_TOKEN=... bash scripts/deploy-cloudflare.sh
# The token is read from the environment and is never printed or written.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "CLOUDFLARE_API_TOKEN is not set — cannot deploy" >&2
  exit 1
fi
export CLOUDFLARE_API_TOKEN

WRANGLER="${WRANGLER_BIN:-/home/user/node_modules/.bin/wrangler}"

echo "==> who am I"
"$WRANGLER" whoami 2>&1 | sed -n '1,12p' || true

if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  ACCOUNT_ID=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    https://api.cloudflare.com/client/v4/accounts \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const a=(j.result||[])[0];console.log(a&&a.id||"")}catch(e){console.log("")}})')
  export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"
fi
echo "==> account: ${CLOUDFLARE_ACCOUNT_ID:-unknown}"

echo "==> 1/3 worker (API + realtime)"
( cd cloudflare/whalechat-api && CI=1 "$WRANGLER" deploy 2>&1 | tail -12 )

echo "==> 2/3 app bundle"
bash scripts/build-pages.sh

echo "==> 3/3 pages (static app)"
"$WRANGLER" pages deploy dist --project-name whalechat --branch main --commit-dirty=true 2>&1 | tail -14

echo "==> deployed"
