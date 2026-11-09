# Deploy WhaleChat to a permanent HTTPS domain

WhaleChat is one Node process (`server.js`) serving one self-contained app file (`whalechat.html`) plus a JSON database in `DATA_DIR`. Render gives you HTTPS, a public URL and automatic deploys from Git.

---

## 1. Put the project on Git

```bash
cd whalechat
git init
git add .
git commit -m "WhaleChat release"
git branch -M main
git remote add origin https://github.com/<you>/whalechat.git
git push -u origin main
```

> Do **not** commit `node_modules/`, `data/` or `*.zip` — `.gitignore` already excludes them.

## 2. Deploy with the included Blueprint

1. Sign in at <https://dashboard.render.com> → **New → Blueprint**.
2. Select the repository. Render reads `render.yaml` automatically.
3. No environment values are required — the server auto-detects `https://<your-service>.onrender.com` from the incoming request. (Optional: set `PUBLIC_URL` only when you attach a custom domain.)
4. Choose the **Starter** instance when asked (the 1 GB disk requires a paid instance type).
5. Click **Apply / Deploy**.

Render will:
- run `npm install --omit=dev`
- start `node server.js`
- health-check `/api/health`
- mount a 1 GB persistent disk at `/var/data` (database + VAPID keys + push subscriptions)
- issue a TLS certificate automatically

**Your final URL** is shown at the top of the service page:
`https://<service-name>.onrender.com` (usually `https://whalechat.onrender.com`; if the name is taken Render appends a suffix).

Verify:

- `https://<service>.onrender.com/` → the app
- `https://<service>.onrender.com/api/health` → `{"ok":true,...}`
- `https://<service>.onrender.com/ref/CODE` → signup with the code pre-filled
- Admin → Release shows the published build and live tabs

> First boot is empty apart from the seeded admin and wholesale catalogue. Sign in with `Admin` / `Admin@12345` and change the password immediately in **Payment Settings → Admin security**.

---

## 3. Point your own domain at Render

1. Render Dashboard → your service → **Settings → Custom Domains → Add Custom Domain**.
2. Enter the host, e.g. `chat.yourdomain.com`.
3. Render shows the DNS target — it is the service hostname, e.g. `whalechat.onrender.com`.
4. At your DNS provider add:

   | Type | Name | Value | TTL |
   |---|---|---|---|
   | `CNAME` | `chat` | `whalechat.onrender.com` | Automatic / 300 |

   - **Apex / root domain** (`yourdomain.com`): use an `ALIAS`/`ANAME` record pointing to `whalechat.onrender.com`, or Render's apex instructions (an `A` record to the IP Render shows on the domain page). Do not use a plain CNAME at the apex unless your DNS provider supports ALIAS.
   - **www**: `CNAME` `www` → `whalechat.onrender.com`, then add `www.yourdomain.com` as a second custom domain.
5. Wait for DNS to propagate (usually minutes). Render issues and renews the Let's Encrypt certificate automatically; the domain turns green with a valid HTTPS padlock.

### After the domain is live

- The public URL is auto-detected, but for a custom domain set `PUBLIC_URL=https://chat.yourdomain.com` (Render → Environment → Save) — or use Admin → Release → **Public app URL** — so release metadata shows the custom domain. Then redeploy/refresh once.
- Set `VAPID_EMAIL` to a real support mailbox so push services can contact you if a subscription breaks.
- Re-scan **Admin → Release** — the app URL and short referral links automatically use the new domain.

---

## 4. User data is never deleted by a release

A release replaces only `whalechat.html` (and optionally `server.js`). Accounts, wallets, messages, orders, vendors and push subscriptions live in `DATA_DIR`, which is separate from the deploy bundle:

- **Render:** persistent disk mounted at `/var/data` (`DATA_DIR=/var/data`). Deploys do not touch it.
- **Docker:** named volume `whalechat-data`.
- **VPS:** `/var/lib/whalechat` (systemd unit).
- Never place `DATA_DIR` inside the Git checkout — `.gitignore` already excludes `data/`.

Automatic protection:
- `POST /api/backup` snapshots the database; one is taken at startup, every hour, on shutdown and before any manual restore.
- The newest **48** snapshots are kept in `BACKUP_DIR` (defaults to `DATA_DIR/backups`; set it to a different persistent path if you like).
- If `state.json` is missing or unreadable at boot, the server **restores the latest backup automatically** instead of starting empty.
- Admin → Release → **Data safety** shows registered accounts, snapshot count, last backup, whether storage is persistent, and provides **Backup now / Download / Restore from file**.
- `/api/state/init` refuses to overwrite an existing database (`409 already_initialised`), so a new client can never replace live accounts.

Environment: `DATA_DIR`, `BACKUP_DIR`, `BACKUP_KEEP` (default 48).

## 5. Updating the app later

1. Replace `whalechat.html` (and `release.json` if you also serve it statically).
2. `git commit && git push` — Render redeploys automatically (`autoDeployTrigger: commit`).
3. Installed PWAs self-update on launch/focus/every 10 minutes; **Admin → Release → Force refresh all devices** reloads every open session immediately.
4. Users never re-download or reinstall.

---

## Keep it always live

A `trycloudflare.com` quick tunnel is for testing only — it reconnects automatically, but if its process stops the hostname returns **Error 1033** and a restart gives a *new* URL. For real uptime use one of these:

**Render (recommended)** — Blueprint above. HTTPS, automatic deploys, health check and a persistent disk. Zero maintenance.

**VPS with systemd** (files in `deploy/`):

```bash
sudo mkdir -p /opt/whalechat /var/lib/whalechat
sudo cp -r . /opt/whalechat && cd /opt/whalechat
sudo npm install --omit=dev
sudo cp deploy/whalechat.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now whalechat
```
`whalechat.service` sets `Restart=always`, so a crash restarts in 2 seconds. HTTP keep-alive and long-lived SSE timeouts are configured inside `server.js`.

**Process manager alternative**

```bash
npm i -g pm2
pm2 start server.js --name whalechat
pm2 save && pm2 startup
```

**Health monitoring** — point UptimeRobot / BetterStack at `https://your-domain/api/health` (expects `200` with `{"ok":true}`). The admin **Release** panel shows uptime, connected tabs and push devices.

**Tunnel supervision** (testing only) — `deploy/start.sh` runs the app and restarts it if it exits; `deploy/whalechat-tunnel.service` keeps a quick tunnel alive. For a permanent tunnel hostname use a **named** Cloudflare tunnel (`cloudflared tunnel create whalechat`) bound to your own domain.

## Push notifications & lock screen

- Notifications use standard **Web Push (VAPID)**, so they arrive with the app closed, the phone locked, or the user signed out — the subscription lives on the server, not in the session.
- One device can hold one subscription per browser profile; the server fans out to **all** registered devices for that user.
- Chat pushes are sent by the server directly from new message records (with a notification fallback), so delivery does not depend on the sender keeping the app open.
- Chat notifications use `requireInteraction` + vibration, keeping the banner on the lock screen until tapped.
- iPhone requires the app to be **added to the Home Screen** (iOS 16.4+); Android Chrome works from the browser or installed app.
- The server logs `[push] -> <user> · devices: N` for every delivery attempt. Admin → Settings shows the registered device count for the signed-in account.

## 6. Other hosts

| Host | Command / config |
|---|---|
| **Fly.io** | `fly launch --no-deploy && fly volumes create whalechat_data --size 1 && fly deploy` (`fly.toml` included) |
| **VPS + Docker** | `cp .env.example .env` (set `DOMAIN`, `PUBLIC_URL`) → `docker compose up -d --build` — Caddy gets HTTPS automatically; point an A record at the server |
| **Railway** | Deploy the repo, add a volume mounted at `/data`, set `DATA_DIR=/data` |
| **Temporary test** | `node server.js` + `cloudflared tunnel --url http://localhost:8090` |

### Environment variables

| Key | Purpose |
|---|---|
| `PORT` | Injected by Render — leave unset there. Locally defaults to 8090 |
| `DATA_DIR` | Database + VAPID keys + push subscriptions (must be persistent) |
| `PUBLIC_URL` | Public HTTPS URL shown in admin/release data |
| `VAPID_EMAIL` | Contact email for Web Push |

### Checklist after going live

- [ ] Change the admin password
- [ ] Set `PUBLIC_URL` to the custom domain
- [ ] Enable push on a phone (Settings → Enable push alerts → Send test)
- [ ] Add your domain's DNS records and confirm the padlock
- [ ] Create a test account and complete a referral signup + contact chat
