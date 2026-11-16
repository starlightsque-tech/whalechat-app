# Deploying WhaleChat to Fly.io

WhaleChat ships as a single Node service with a persistent volume for its database,
backups and the recorded Finnhub tick history. The repo already contains everything
Fly needs (`Dockerfile`, `fly.toml`, `/api/health`).

## One-time setup

```bash
# 1. install + authenticate flyctl
curl -fsSL https://fly.io/install.sh | sh
export PATH="$HOME/.fly/bin:$PATH"
fly auth login                      # or: export FLY_API_TOKEN=...

# 2. create the app (skip if it already exists)
cd whalechat-app
fly apps create whalechat-live      # change the name if it is taken

# 3. persistent volume for DATA_DIR=/data (SQLite-style state.json, backups, tick history)
fly volumes create wc_data --size 1 --region iad --app whalechat-live

# 4. secrets — never bake keys into the image
fly secrets set FINNHUB_API_KEY="<your finnhub key>" --app whalechat-live
# optional
fly secrets set VAPID_EMAIL="support@whalechat.app" --app whalechat-live
```

`PUBLIC_URL` is optional: the app derives it from `FLY_APP_NAME` /
`FLY_PUBLIC_IP` when it is not set.

## Deploy

```bash
fly deploy --app whalechat-live
fly open --app whalechat-live            # https://whalechat-live.fly.dev
fly logs --app whalechat-live
fly status --app whalechat-live
```

The image runs `node scripts/prepare-assets.js` at build time, so `public/whalechat.html`
is assembled from its parts and every app module (session guard, charts, market bridge,
… ) is injected into the bundle automatically.

## What `fly.toml` sets up

| Setting | Value | Why |
|---|---|---|
| `internal_port` | 8090 | matches `PORT` in the image |
| `force_https` | true | the PWA + WebSocket need TLS |
| `auto_stop_machines` | false | the app must stay up so scheduled workers, TP/SL settlement and push keep running |
| `min_machines_running` | 1 | always one warm machine for instant responses |
| health check | `GET /api/health` every 15 s | Fly restarts a wedged instance automatically |
| concurrency | soft 200 / hard 250 | plenty of headroom for a single Node process |
| VM | shared-cpu-1x · 512 MB | fits the app + market worker comfortably |
| mount | `wc_data` → `/data` | state, backups and `market-history.json` survive deploys |

## Scaling notes

* **One machine only.** The store is a JSON database on the mounted volume and the market
  worker holds in-process state, so `fly scale count 1`. For more traffic, raise the VM
  (`fly scale vm shared-cpu-2x --memory 1024`) rather than adding machines.
* **Postgres** is supported natively — set `DATABASE_URL` and the app stores state there
  instead of `/data`, which then allows multiple machines.
* **Deploys never wipe data**: the volume is detached/reattached, `DATA_DIR` stays `/data`.

## Updating

```bash
git pull
fly deploy --app whalechat-live
```

Clients pick the new release up through the in-app update sheet — and the session guard
holds the refresh back while someone is typing, then applies it when the screen is idle.

## Troubleshooting

| Symptom | Check |
|---|---|
| `503` right after deploy | `fly logs` — usually a missing volume (`fly volumes list`) |
| app boots but data is empty | the volume is not mounted at `/data` (`fly ssh console -C 'ls /data'`) |
| market feed offline | `fly secrets list` shows `FINNHUB_API_KEY`, then `curl https://<app>.fly.dev/api/market/status` |
| `app name already taken` | pick another name in `fly.toml` and `fly apps create` |
