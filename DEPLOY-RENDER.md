# WhaleChat on Render — always reachable, never a cold start

_Last verified: 2026-11-14 · app 3.36.6 · https://whalechat-qkgd.onrender.com_

The service is live at **https://whalechat-qkgd.onrender.com** and deploys
automatically from `main` (`render.yaml`, Node runtime, disk at `/var/data`).

## What the app already does for availability

| Concern | Handling |
|---|---|
| New visitor can sign up / sign in | No device registration anywhere; accounts are created locally first, then synced |
| Broken/legacy accounts | Account records are normalised at boot (missing username/email no longer abort sign-up or sign-in) |
| Flaky mobile connection | Failed syncs retry with backoff (4 s → 60 s) and the account still exists on the device |
| Page refresh | Typed values, scroll and route are snapshotted and restored; updates never reload while you type |
| Cold start | The last real quotes and tick history are cached in `/var/data`, so the first paint after a restart already shows real prices |
| Load size | Brotli: 1.42 MB bundle → **282 KB** |

## UptimeRobot — copy-paste settings (free, keeps the instance awake)

Create a free account at <https://uptimerobot.com> → **Add New Monitor** and paste:

| Field | Value |
|---|---|
| **Monitor Type** | `HTTPS` |
| **Friendly Name** | `WhaleChat Render` |
| **URL (or IP)** | `https://whalechat-qkgd.onrender.com/api/health` |
| **Monitoring Interval** | `5 minutes` |
| **HTTP Method** | `GET` |
| **Timeout** | `30 seconds` (covers a Render cold start) |
| **Alert Contacts** | your email (default) |
| **Keyword (optional)** | Type: `Keyword exists` · Keyword: `"ok":true` |
| **Custom HTTP headers** | none |
| **HTTP authentication** | none |

That's it — a `GET` every 5 minutes counts as traffic on Render, so the free instance
stays warm and no visitor meets a 30–60 s cold start. (UptimeRobot's free plan allows
5-minute intervals and up to 50 monitors.)

Quick check that the endpoint is the right one:

```bash
curl -s https://whalechat-qkgd.onrender.com/api/health
# {"ok":true,"app":"whalechat","version":"3.37.0", ...}
```

## Other keep-alive options

Render's free instances stop after 15 minutes without traffic, so the next visitor
waits 30–60 s for a cold start. Pick one:

### 1. Upgrade the instance (simplest, official)
Render dashboard → the service → **Settings → Instance Type → Starter**. No spin-down,
no cold start, always-on. `render.yaml` already declares `plan: starter`.

### 2. Free external pinger (no plan change)
Create a free monitor at UptimeRobot / cron-job.org / Freshping:

* URL: `https://whalechat-qkgd.onrender.com/api/health`
* Method: `GET`
* Interval: **5–10 minutes** (Render counts any request as activity)

`/api/health` is tiny, unauthenticated and returns `{ ok: true }` — safe to poll.

### 3. GitHub Actions cron (needs workflow permission)
Copy `deploy/keepalive.workflow.yml.example` to `.github/workflows/keepalive.yml`
and commit it with an account that can write workflows (the Creao GitHub App is not
allowed to create workflow files). It pings `/api/health` every 10 minutes.

## Verify a deployment

```bash
curl -s https://whalechat-qkgd.onrender.com/api/health | jq '{version, uptimeSec, users}'
curl -s -o /dev/null -D - -H 'Accept-Encoding: br' https://whalechat-qkgd.onrender.com/whalechat.html | grep -i content-encoding
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| “A request failed — check your connection and retry.” | Update to 3.36.5+ (legacy-account crash fixed); this toast is now suppressed |
| Sign-up shows a red error but fields stay | The account data is intact — tap **Create account** again, or use a different username/email |
| Phone “already registered” | Only a note now — sign-up continues |
| First load after hours is slow | Free instance cold start — see the keep-alive options above |
