#!/usr/bin/env bash
# Permanent Cloudflare named tunnel for WhaleChat.
# Usage: sudo ./deploy/setup-cloudflare-tunnel.sh chat.yourdomain.com [tunnel-name] [local-port]
# Prerequisites: domain on Cloudflare, cloudflared installed, `cloudflared tunnel login` done.
set -euo pipefail

DOMAIN="${1:-}"
NAME="${2:-whalechat}"
PORT="${3:-8090}"
CF_HOME="${HOME}/.cloudflared"
[ "$(id -u)" = "0" ] && CF_HOME="/root/.cloudflared"

if [ -z "$DOMAIN" ]; then
  echo "Usage: sudo $0 chat.yourdomain.com [tunnel-name] [local-port]"; exit 1
fi
command -v cloudflared >/dev/null || { echo "cloudflared not installed. See DEPLOY-CLOUDFLARE.md"; exit 1; }
if [ ! -f "$CF_HOME/cert.pem" ]; then
  echo "Not logged in. Run:  cloudflared tunnel login"; exit 1
fi

UUID=$(cloudflared tunnel list --output json 2>/dev/null | python3 -c "
import sys,json
try: data=json.load(sys.stdin)
except Exception: sys.exit(0)
for t in data:
    if t.get('name')=='$NAME': print(t.get('id','')); break
")
if [ -z "$UUID" ]; then
  echo "[tunnel] creating '$NAME'…"
  cloudflared tunnel create "$NAME" >/dev/null
  UUID=$(cloudflared tunnel list --output json | python3 -c "
import sys,json
data=json.load(sys.stdin)
print(next((t['id'] for t in data if t.get('name')=='$NAME'),''))
")
fi
[ -n "$UUID" ] || { echo "Could not determine tunnel UUID"; exit 1; }
echo "[tunnel] $NAME = $UUID"

CONFIG_DIR="/etc/cloudflared"
sudo mkdir -p "$CONFIG_DIR"
if [ -f "$CONFIG_DIR/config.yml" ]; then
  sudo cp "$CONFIG_DIR/config.yml" "$CONFIG_DIR/config.yml.bak.$(date +%s)"
fi
sudo tee "$CONFIG_DIR/config.yml" >/dev/null <<YAML
tunnel: $UUID
credentials-file: $CF_HOME/$UUID.json

ingress:
  - hostname: $DOMAIN
    service: http://127.0.0.1:$PORT
    originRequest:
      connectTimeout: 30s
      noTLSVerify: true
  - service: http_status:404
YAML

echo "[tunnel] routing DNS $DOMAIN → $UUID"
cloudflared tunnel route dns "$NAME" "$DOMAIN" || true

if systemctl list-unit-files | grep -q '^cloudflared.service'; then
  sudo systemctl restart cloudflared
else
  sudo cloudflared service install
  sudo systemctl enable --now cloudflared
fi
sudo systemctl --no-pager status cloudflared | head -n 8 || true

echo ""
echo "Tunnel is live at https://$DOMAIN"
echo "Next: set PUBLIC_URL=https://$DOMAIN in /etc/systemd/system/whalechat.service"
echo "      (or Admin → Release → Public app URL), then: sudo systemctl restart whalechat"
