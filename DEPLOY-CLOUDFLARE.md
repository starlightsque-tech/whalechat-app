# Deploy WhaleChat permanently with Cloudflare

Two supported patterns. **Option A** keeps the full product (cross‑device sync, push, admin, persistent database) on your own server and gives it a permanent HTTPS hostname through Cloudflare. **Option B** hosts the static app on Cloudflare Pages and connects it to an existing sync server.

---

## Option A — Cloudflare Tunnel to your WhaleChat server (recommended)

You need: a domain on Cloudflare (nameservers pointed at Cloudflare) and a small VPS (or any always‑on machine) running `server.js`.

### 1. Run the server

```bash
sudo mkdir -p /opt/whalechat /var/lib/whalechat
sudo cp -r whalechat-app/* /opt/whalechat && cd /opt/whalechat
sudo npm install --omit=dev
sudo cp deploy/whalechat.service /etc/systemd/system/whalechat.service
# edit Environment= lines: DATA_DIR=/var/lib/whalechat, PUBLIC_URL=https://chat.yourdomain.com
sudo systemctl daemon-reload && sudo systemctl enable --now whalechat
curl -s http://127.0.0.1:8090/api/health
```

### 2. Install cloudflared

```bash
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared
cloudflared --version
```

### 3. Create a named tunnel (or run the helper)

One command after `cloudflared tunnel login`:

```bash
sudo ./deploy/setup-cloudflare-tunnel.sh chat.yourdomain.com whalechat 8090
```

It creates/reuses the tunnel, writes `/etc/cloudflared/config.yml`, routes DNS and installs the service. Manual steps follow if you prefer.

### 3b. Manual steps

```bash
cloudflared tunnel login                 # opens a browser, pick your domain
cloudflared tunnel create whalechat      # prints the tunnel UUID
```

Create `/etc/cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: /root/.cloudflared/<TUNNEL-UUID>.json

ingress:
  - hostname: chat.yourdomain.com
    service: http://127.0.0.1:8090
    originRequest:
      noTLSVerify: true
      connectTimeout: 30s
      # keep Server-Sent Events streaming
      disableChunkedEncoding: false
  - service: http_status:404
```

Route DNS (creates the CNAME for you):

```bash
cloudflared tunnel route dns whalechat chat.yourdomain.com
```

### 4. Run it as a service

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared --no-pager
```

### 5. Finish

- Set the public URL **either** in `/etc/systemd/system/whalechat.service` (`PUBLIC_URL=https://chat.yourdomain.com`) **or** in Admin → Release → **Public app URL** (stored in the database, no restart needed), then `sudo systemctl restart whalechat` if using the env var.
- `/api/health`, `/api/release` and the admin Server-details panel then report the public URL.
- Open `https://chat.yourdomain.com` — Cloudflare terminates TLS, the app connects automatically (server-served marker), push and live sync work over HTTPS.
- Admin → **Release → Data safety** should show **Protected** and the persistent data directory.

### Cloudflare notes

- **Never** enable “Under Attack” or a WAF challenge on `/api/*` — it breaks the app’s SSE sync and push subscription calls. Allow `/api/*` and `/sw.js`.
- Do not cache `/api/*`, `/release.json` or `/whalechat.html` at the edge; the server already sets the right headers. If you add a Cache Rule, bypass for those paths.
- SSE requires no buffering; the tunnel passes it through. Nginx/Caddy in front should also disable buffering.
- Backups remain on the server (`/var/lib/whalechat`), independent of Cloudflare. Point `BACKUP_DIR` at a second disk/object store if you want off‑box copies.

---

## Option B — Cloudflare Pages (static app) + sync server

Use this if you only want to host the HTML on Cloudflare and already run `server.js` somewhere (Render/VPS).

1. Set the sync server in the build so the app auto-connects. In `whalechat.html` (or your build) change:
   ```js
   const DEFAULT_SYNC_SERVER = 'https://sync.yourdomain.com';
   ```
   Alternatively open the app once as `https://app.yourdomain.com/?server=https://sync.yourdomain.com` — the URL is remembered on the device.
2. Deploy the static files with Wrangler:
   ```bash
   npm i -g wrangler
   wrangler pages project create whalechat
   wrangler pages deploy whalechat-app --project-name whalechat
   ```
   Files needed: `whalechat.html`, `index.html`, `manifest.webmanifest`, `sw.js`, `assets/`, `release.json`. (No `server.js`, no `data/`.)
3. Add your custom domain: Pages → Custom domains → `app.yourdomain.com` (CNAME is created automatically).
4. The server must allow cross-origin API calls — it already sends `Access-Control-Allow-Origin: *`.
5. Push subscriptions are created for the Pages origin; the service worker on Pages receives them even though the API lives on the sync server. Both must be HTTPS.

**Important:** Pages alone cannot run `server.js` (no persistent process or disk). Without the sync server, the app runs in single-device mode and push/referrals/contacts across devices will not work.

---

## What Cloudflare Workers cannot do here

WhaleChat’s backend needs a long‑lived Node process (Server‑Sent Events), a persistent JSON database, and VAPID push. Cloudflare Workers are request‑scoped with no local disk; porting would require Durable Objects + KV + a rewrite of the sync protocol. Use Option A.

---

## Verify after deployment

| Check | Expected |
|---|---|
| `https://chat.yourdomain.com/` | WhaleChat loads |
| `/api/health` | `{"ok":true,...}` |
| `/release.json` | current build stamp |
| Admin → Release | server build, users, uptime, backups |
| Admin → Settings → Server details | connected URL, revision, push devices, VAPID |
| Settings | notification test arrives on the lock screen |
| Referral link | `https://chat.yourdomain.com/ref/CODE` opens signup |

## Updates

Replace `whalechat.html` + `release.json` on the server, `sudo systemctl restart whalechat`. Installed apps update automatically; **Admin → Release → Force refresh all devices** reloads open sessions. User data is untouched (separate `DATA_DIR`).
