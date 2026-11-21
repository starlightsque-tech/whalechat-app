# Deploy WhaleChat to Cloudflare Pages (PWA)

The client is a self-contained PWA. Cloudflare Pages serves `public/` **and**
runs the edge backend in `public/_worker.js`:

- email verification codes, SMS OTP and admin email/SMS are generated and sent
  from the Worker through **Brevo** (API + transactional SMS);
- every other `/api/*` request is proxied to the WhaleChat sync service.

Required Pages environment variables:

| Variable | Value |
| --- | --- |
| `BREVO_API_KEY` | Brevo API key (`xkeysib-…`) |
| `BREVO_SENDER_EMAIL` | a verified Brevo sender |
| `BREVO_SENDER_NAME` | `Whalechat` |
| `BREVO_SMS_SENDER` | approved SMS sender, max 11 chars |
| `WC_OTP_SECRET` | long random secret for HMAC one-time codes |
| `SYNC_ORIGIN` | `https://whalechat-api.appwrite.network` |

Brevo SMS requires an SMS add-on/credits on the Brevo account.

## One-time credentials

Create a Cloudflare API token with:

- Account → Cloudflare Pages → Edit
- Account → Account Settings → Read

Export `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (or save them as
CREAO secrets). Never commit them.

## Deploy

```bash
npm run deploy:cloudflare
```

The script:

1. assembles `public/whalechat.html` and the offline manifest,
2. creates the `whalechat` Pages project if needed,
3. uploads `public/` with Wrangler and activates the deployment.

Production URL: **https://whalechat.pages.dev**

## PWA layer

- `public/manifest.webmanifest` — standalone display, icons, shortcuts.
- `public/sw.js` — app-shell precache, API stale-while-revalidate, offline
  fallback, background sync for queued chat/trades, Web Push.
- `public/offline-manifest.json` — every file needed with no network.
- Browser storage: `localStorage` for the app database/session and IndexedDB
  for the chat archive, outbox, device DB and cached API/static assets.
- `public/_headers` — no-cache for `sw.js`, manifest MIME type, long-lived
  immutable assets, security headers.
- `public/_redirects` — root to the branded splash (`index.html`).

Cloudflare Pages redirects `/whalechat.html` to `/whalechat` (pretty URLs);
the Service Worker caches both the navigation and the shell, so the installed
app still opens with the network off.
