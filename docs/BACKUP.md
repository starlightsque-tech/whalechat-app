# Supabase lifecycle, keep-alive, backup and restore

## What actually pauses a free Supabase project

Supabase pauses **free** projects after **7 consecutive days without activity**.
"Activity" means requests that reach the project: database queries, REST/GraphQL
requests, Auth calls, Storage calls, Realtime connections and Edge Function
invocations. Nothing else counts — editing files in this repo, a Render ping that
never touches the database, or browsing the dashboard does not keep it awake.

Other free-tier facts worth knowing:

| Situation | What happens |
| --- | --- |
| 7 days with no project activity | Project is **paused**. Every endpoint fails (connection refused / 5xx) until you restore it. |
| More than 2 active free projects in one organisation | Older free projects can be paused automatically. |
| Paused project | Data is retained; restoring from the dashboard takes a few minutes. The app is designed to survive this window (see below). |
| Free tier limits (DB size, egress, storage) | Throttling/limits, not an immediate pause. |

## How this project stays active

Two layers, because either one alone has a hole:

1. **In-app heartbeat** — while the web service is running, `server.js` writes to
   `whalechat_heartbeat` every 5 minutes. That is constant database activity
   during normal use. (Render's free plan sleeps the service after ~15 minutes
   idle, which is the hole.)
2. **GitHub Actions keep-alive** — `.github/workflows/keepalive.yml` runs every
   6 hours and calls Supabase Auth health + a REST probe, plus the app's
   `/api/health`. This covers the hours where nobody is using the app and the
   Render instance is asleep.

Requires the repository secret `SUPABASE_ANON_KEY` (already set). The keep-alive
also logs the HTTP codes; `200` or `401` both count as activity.

Caveats, stated plainly:

* GitHub disables **scheduled** workflows after 60 days of repository
  inactivity — any push re-enables them.
* Scheduled runs can start a few minutes late; that is irrelevant at a 7-day
  threshold.
* A Render free service still sleeps between pings; the app's cold-start
  handling (next section) is what makes that harmless.

## Cold / resumed Supabase cannot break chat sync or alerts

`initStorage()` used to give up permanently on the first failed connection and
fall back to the ephemeral file — which on Render's free plan means data loss on
the next restart. It now behaves differently:

| Event | Behaviour |
| --- | --- |
| First connection fails (paused or cold project) | Service keeps serving from the in-memory/file state; reconnects with backoff 5 s → 9 s → 16 s → … capped at 60 s, forever. |
| A **write** fails mid-session | The dead pool is dropped, the reconnect is scheduled, and the state stays in memory so nothing is lost from the user's point of view. |
| Reconnect after the project resumes | `rev` numbers are compared. If Postgres is **newer** it is adopted (and clients are told to refresh); if the device is newer, it is pushed. No blind overwrite in either direction. |
| Normal operation | A heartbeat row is written every 5 minutes. |

Chat sync and price alerts read from the in-process state, so they keep working
through all of the above; only durability is deferred until the reconnect.
`/api/health` exposes the truth:

```json
"storage": "postgres",
"storageDetail": {
  "connected": true, "attempts": 1, "lastError": null,
  "lastConnectAt": 1795043047482, "lastWriteAt": 1795043051918,
  "lastAdopt": "remote", "retryInMs": 0
}
```

`lastAdopt` is `remote` when it took Postgres' state, `local` when it pushed the
device's state, `local-seed` when it seeded an empty database.

## Daily backup

`scripts/backup-state.mjs` exports the single `whalechat_state` row — the whole
app database — to a dated JSON file with a checksum, and prunes anything older
than 14 days.

```bash
DATABASE_URL='postgresql://…' npm run backup:state
# → backups/whalechat-state-2026-11-18.json  (+ .sha256)
```

Options: `--out=DIR` (default `./backups`), `--retention=14`, `--quiet`, and
`--via=management` to use `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_REF`
instead of a database URL.

**Automation:** `.github/workflows/backup.yml` runs daily at **02:30 UTC** and
uploads the file as a workflow artifact with `retention-days: 14`, so GitHub
keeps the last 14 daily copies for you. It needs the `DATABASE_URL` repository
secret (already set).

Download it locally, any of these ways:

* GitHub → **Actions → Daily Supabase state backup → latest run → Artifacts**.
* CLI: `gh run download -n whalechat-state-2026-11-18`
* Or run the script yourself against `DATABASE_URL` and keep the file anywhere.

Verify what you downloaded:

```bash
sha256sum -c whalechat-state-2026-11-18.sha256
```

The file shape is `{ exportedAt, rev, updatedAt, users, db }` where `db` is the
entire application database (users, orders, chats, market state, alerts…).

## Restore from a backup

```bash
# 1. inspect what will happen (no writes)
DATABASE_URL='postgresql://…' node scripts/restore-state.mjs \
  --file=backups/whalechat-state-2026-11-18.json

# 2. apply
DATABASE_URL='postgresql://…' node scripts/restore-state.mjs \
  --file=backups/whalechat-state-2026-11-18.json --yes

# 3. restart the web service so it loads the restored row
```

Restore details:

* It saves the **current** row to `<file>.pre-restore.json` before touching
  anything, so a bad restore can be undone the same way.
* It writes `rev = max(current, backup) + 1`, so every connected device sees the
  restore as newer and refreshes instead of pushing stale state back.
* It refuses to run without `--yes`, and refuses payloads without a `users`
  array unless you add `--force`.
* Restarting the service: Render dashboard → Manual Deploy, or
  `POST /v1/services/<id>/deploys` with your Render API key.

Manual alternative (Supabase SQL editor):

```sql
update whalechat_state
set db = '<paste the "db" object here>'::jsonb,
    rev = rev + 1,
    updated_at = now()
where id = 1;
```

Then restart the service. Server snapshots in `DATA_DIR/backups/state-*.json`
use the same `{ rev, db }` shape and can be passed to the same restore script.
