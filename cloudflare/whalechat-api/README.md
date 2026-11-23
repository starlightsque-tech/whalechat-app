# WhaleChat sync API (Cloudflare Workers + Durable Objects)

The live chat backend for `https://whalechat.pages.dev/whalechat`.

One Durable Object (`ChatHub`) owns the database, presence, typing, messages and
session rooms, and pushes every change over a single SSE stream per device.
The Pages app talks to it through `DEFAULT_SYNC_SERVER` in
`public/whalechat.html.part01`.

```
https://whalechat-api.starlightsque.workers.dev
```

## Deploy

```bash
cd cloudflare/whalechat-api
export CLOUDFLARE_API_TOKEN=...        # Workers Scripts: Edit + Durable Objects: Edit
export CLOUDFLARE_ACCOUNT_ID=...
npx wrangler deploy
```

## Cloudflare D1 database

The Durable Object mirrors every save into D1 database **`whalechat_db`**
(bound as `env.DB`), and hydrates from D1 when its own storage is empty.
The deployed worker reports `"storage":"d1+durable-object"` on `/api/health`.

```
database_name = whalechat_db
database_id   = 9fe22a65-e6f0-4e1b-a791-bc9ef8023f59
```

- `schema.sql` creates the tables (`app_state_chunks`, `users`, `messages`,
  `files`, `sessions`). Apply it once with `npm run db:init`.
- Verify the binding, tables, chunk snapshot and restored accounts with
  `npm run db:check`.
- Only the active Durable Object is allowed to write to D1. Instances left
  over from an older version keep their alarms running after a publish, so
  without this guard they could overwrite fresh data with their old copy.

## Updating the Worker

A running Durable Object keeps the code it started with, so bump `DO_NAME` and
set `PREV_DO_NAME` to the old name at the top of `src/index.js` before deploying.
The new object copies the database (including the VAPID key and push
subscriptions) from the previous one on first use. Chat and markets come back
without signing anyone out.

## Verify

```bash
curl https://whalechat-api.starlightsque.workers.dev/api/health
curl -N 'https://whalechat-api.starlightsque.workers.dev/api/events?user=test'
```

- `GET /api/state` returns the whole app state, `POST /api/ops` applies diffs.
- `POST /api/messages/send`, `GET /api/messages/list`, `POST /api/messages/ack`.
- `POST /api/presence`, `POST /api/typing`, `GET /api/events` (SSE).
- `GET /api/push/key`, `POST /api/push/subscribe`, `POST /api/push/test` (Web Push).
- `GET /api/market/quotes|history|stream` (Yahoo Finance public feed).
- `POST /api/rooms/create|join|message|read|typing`, `GET /api/rooms/list|get`.

Push notifications use a VAPID key generated once and stored in Durable Object
storage. Market quotes refresh from Yahoo Finance in batches of 20 every 30 s.

Email OTP verification runs in this Worker over the Brevo HTTPS API. Codes are
stored in D1 (`email_codes`) and there is no SMTP connection to keep alive.

```bash
cd cloudflare/whalechat-api
npx wrangler secret put BREVO_API_KEY     # paste the Brevo API key once
npx wrangler deploy
curl https://whalechat-api.starlightsque.workers.dev/api/health
# -> "brevoConfigured": true
```

`BREVO_SENDER_EMAIL` and `BREVO_SENDER_NAME` live in `wrangler.toml` `[vars]`
and survive deploys. The sender address must be verified in Brevo.
