# Deploy WhaleChat to Appwrite

WhaleChat uses Appwrite for **two** things:

1. **Client hosting** — the assembled `public/` app is deployed as an Appwrite
   Site (`scripts/deploy-appwrite.mjs`).
2. **Durable data mirror** — the Node sync server keeps the whole database and
   uploaded app files in Appwrite Storage/Database (`appwrite.js`), so a Render
   redeploy, a disk reset or a sleeping instance can never erase accounts,
   balances or active trades.

## 1. Appwrite project

1. Create a project at <https://cloud.appwrite.io> and copy its **Project ID**.
2. Project Settings → API Keys → create a key with scopes:
   `sites.*`, `storage.*`, `databases.*`, `files.*`.
3. Keep the key outside the repo (Render env var or your shell).

## Build gate (connection verification)

`npm run build` first runs `node scripts/verify-connections.js`. The build is
BLOCKED unless the sync function, market providers, quote proxy, shares engine
and published site all answer. `WC_SKIP_VERIFY=1` is for local work only.

## 2. Deploy the client to Appwrite Sites

```bash
APPWRITE_ENDPOINT=https://nyc.cloud.appwrite.io/v1 \
APPWRITE_PROJECT_ID=6afec9ae002d0af5e0c6 \
APPWRITE_API_KEY=<api-key> \
npm run deploy:appwrite
```

The live site is **https://whalechat.appwrite.network**.

The script:

* runs `node scripts/prepare-assets.js` (assembles `whalechat.html`),
* creates the `whalechat` site if it does not exist,
* packages `public/` as a tar.gz and uploads a static deployment,
* activates it and waits for `ready`.

The site is served from `https://<site-id>.<appwrite-domain>` (the exact host is
shown in the Appwrite console → Sites → Domains).

## stock-proxy function

A dedicated quote function is deployed at function id `stock-proxy`
(`https://nyc.cloud.appwrite.io/v1/functions/stock-proxy/executions`).
It accepts `?symbols=AAPL,TSLA` or a POST body `{"symbols":"AAPL,TSLA"}` and
fails over Finnhub → Twelve Data → Alpha Vantage → memory cache. Provider keys
live in its variables (`FINNHUB_KEY`, `TWELVE_DATA_KEY`, `ALPHA_VANTAGE_KEY`).

Email: the sync function sends verification, welcome and transactional mail
through Brevo (`/api/email/status` → provider: brevo).

## 3. Enable the server-side data mirror

Set these on Render (Environment):

| Variable | Value |
| --- | --- |
| `APPWRITE_ENDPOINT` | `https://nyc.cloud.appwrite.io/v1` |
| `APPWRITE_PROJECT_ID` | `6afec9ae002d0af5e0c6` |
| `APPWRITE_API_KEY` | the key from step 1 |
| `APPWRITE_BUCKET_ID` | `whalechat` (created automatically) |
| `APPWRITE_DATABASE_ID` | `whalechat` (optional document mirror) |

On boot the server downloads `whalechat-state.json` from Appwrite and **merges**
it with the local state (accounts are added, never deleted). Every database
write schedules a backup, a full backup runs every 5 minutes and on shutdown.

Check it:

```bash
curl https://<render-host>/api/appwrite/status
```

Manual backup (admin token required):

```bash
curl -X POST https://<render-host>/api/appwrite/sync \
  -H "x-admin-token: <admin session>"
```

## 4. Email verification codes

Sign-up and password reset send a 6-digit code. Configure any one provider:

* `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (Outlook/Microsoft 365)
* `RESEND_API_KEY`
* `BREVO_API_KEY`

If none is configured the app shows the code on screen (clearly labelled) so
account creation and password reset never dead-end. Configure mail to have the
code delivered to the user's inbox.

## 5. Notes

* Never commit `APPWRITE_API_KEY`; rotate it if it is ever pasted in chat.
* `APPWRITE_*` variables are server/CI only. The browser app has no Appwrite
  key and talks only to the WhaleChat sync server.

## 6. Sync service (live)

The Appwrite site is static, so cross-device sync and email codes are served
by an Appwrite **Function** named `whalechat-sync`:

* Function URL: **https://whalechat-api.appwrite.network**
* Client constant: `DEFAULT_SYNC_SERVER` in `public/whalechat.html.part01`
* State: `whalechat-state.json` in the `whalechat` Storage bucket (delete +
  recreate on every write, because Appwrite's update-file endpoint only changes
  metadata)
* Transport: HTTP polling every 15 s (Functions cannot hold SSE open)
* Email codes: `whalechat-codes.json` in the same bucket; set `RESEND_API_KEY`
  or `BREVO_API_KEY` as a function variable to deliver mail, otherwise the code
  is returned to the app and shown in a labelled fallback panel.

Redeploy the function after changing `appwrite-function/index.js`:

### Function environment variables

| Variable | Purpose |
| --- | --- |
| `FINNHUB_API_KEY` (or `FINNHUB_KEY`) | Server-side Finnhub quotes. Never sent to the browser. |
| `TWELVE_DATA_API_KEY` (or `TWELVEDATA_API_KEY`, `TWELVE_DATA_KEY`) | Server-side Twelve Data quotes / fallback. |
| `WC_APPWRITE_KEY` | Storage key the function already uses for the state file. |
| `BREVO_API_KEY` | Verification and transactional email. |

With a provider key set, every device gets real stock quotes through
`GET /api/market/proxy?provider=auto&symbols=AAPL,MSFT,…` — no key is ever
pasted into a browser. The function also runs the WhaleChat shares engine
(plans, accruals, maturities, payouts) so those calculations happen on
Appwrite storage even when the Render server is asleep.

Function endpoints added in 3.59.0:

```
GET  /api/market/keys                 → { finnhub, twelvedata, binance } availability only
GET  /api/market/proxy?symbols=…      → normalised quotes from the env-var keys
GET  /api/market/status               → feed + catalogue counts
GET  /api/shares/state?userId=…       → plans, live accruals, completed payouts
POST /api/shares/invest               → buy shares (accrual + maturity handled here)
GET  /api/shares/admin                → admin plans / market / settings
POST /api/shares/admin/plans|settings|investment
POST /api/admin/session/auto          → signed admin token (no unlock code)
```

```bash
export APPWRITE_ENDPOINT=https://nyc.cloud.appwrite.io/v1
export APPWRITE_PROJECT_ID=6afec9ae002d0af5e0c6
export APPWRITE_API_KEY=...
appwrite functions create-deployment \
  --function-id whalechat-sync \
  --code appwrite-function --activate \
  --entrypoint index.js --commands "npm install"
```

Health check:

```bash
curl https://whalechat-api.appwrite.network/api/health
```

## 7. Admin panel

A separate, standalone admin panel is deployed as its own Appwrite Site:

* **URL:** https://whalechat-admin.appwrite.network
* **Source:** `admin-panel/index.html`
* **API:** the same `whalechat-sync` function
* **Initial account:** the seeded WhaleChat admin (`admin@whalechat.app`) with
  the app's default admin password. Change it from **Account security** on the
  first sign-in.

Admin endpoints on the function:

| Endpoint | Purpose |
| --- | --- |
| `POST /api/admin/login` | verify email/username + password, issue 8-hour token |
| `POST /api/admin/me` | validate a token |
| `POST /api/admin/update` | change email, username or password |
| `POST /api/admin/set-recovery` | store a hashed recovery key |
| `POST /api/admin/recovery` | reset password with recovery key |
| `POST /api/admin/user-flag` | verify / ban a user |

Redeploy the admin site after editing `admin-panel/index.html`:

```bash
APPWRITE_ENDPOINT=https://nyc.cloud.appwrite.io/v1 \
APPWRITE_PROJECT_ID=6afec9ae002d0af5e0c6 \
APPWRITE_SITE_ID=whalechat-admin \
APPWRITE_SITE_NAME="WhaleChat Admin" \
APPWRITE_SITE_DIR=admin-panel \
APPWRITE_SKIP_BUILD=1 \
npm run deploy:appwrite
```

## 8. Email & notification audit

Every Brevo message is appended to the private `whalechat-email-log.json`
storage file with recipient, template type, full verification code (15-minute
TTL), Brevo message id, status and error. Admin panel → **Email & notifications**
shows the log, the verified Brevo sender, a welcome-email tester and the in-app
notification audit.

Endpoints (admin token required except status/test):

| Endpoint | Purpose |
| --- | --- |
| `GET /api/email/status` | Brevo configuration |
| `POST /api/admin/email-log` | audit entries |
| `POST /api/admin/senders` | Brevo sender list |
| `POST /api/admin/welcome-test` | send + log a welcome email |
| `POST /api/email/test` | send + log a test email |
| `POST /api/email/broadcast` | send + log an admin broadcast |

## 9. Brevo delivery webhook

`POST https://whalechat-api.appwrite.network/api/webhook/brevo` receives Brevo
transactional events. It is authenticated with the `x-whalechat-key` header
created together with the webhook (the key is stored only in the private
`whalechat-mail.json` snapshot).

The function subscribes Brevo to `request, delivered, opened, uniqueOpened,
click, hardBounce, softBounce, blocked, spam, invalid, deferred, unsubscribed`
and matches each event to the audit entry by `message-id` (recipient + subject
fallback). Status badges in the admin panel therefore move from **Accepted** to
**Delivered**, **Opened**, **Clicked**, **Bounced**, etc.

Admin panel → **Email & notifications → Delivery webhook → Connect webhook**
creates or re-checks the Brevo webhook through `/api/admin/webhook-setup`.
