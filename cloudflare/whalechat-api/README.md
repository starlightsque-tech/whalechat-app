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

## Verify

```bash
curl https://whalechat-api.starlightsque.workers.dev/api/health
curl -N 'https://whalechat-api.starlightsque.workers.dev/api/events?user=test'
```

- `GET /api/state` returns the whole app state, `POST /api/ops` applies diffs.
- `POST /api/messages/send`, `GET /api/messages/list`, `POST /api/messages/ack`.
- `POST /api/presence`, `POST /api/typing`, `GET /api/events` (SSE).
- `POST /api/rooms/create|join|message|read|typing`, `GET /api/rooms/list|get`.

Email OTP verification still runs on the Pages Functions (`functions/api/otp/*`)
because that is where the Brevo key and KV binding live.
