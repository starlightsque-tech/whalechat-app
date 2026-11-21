# Deploy WhaleChat to Cloudflare Pages (PWA)

The client is a self-contained PWA. Cloudflare Pages serves `public/`; the
API/sync backend remains the Appwrite Function configured in the app.

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
