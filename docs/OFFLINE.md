# WhaleChat offline mode (3.48.0)

The installed app is designed to run from the device. This page explains exactly
what works with no connection, what needs the network, and how the price alerts
reach the home screen and lock screen.

## What works with the network completely off

| Area | Offline behaviour |
| --- | --- |
| App launch | Opens from the pre-cached build (service worker `wc-v3.48.0-1`). Every module in `public/` is pre-cached after the first load — see `public/offline-manifest.json`. |
| Signed-in session | Restored from the device (`session-guard` + IndexedDB). No login round-trip is required to open the app. |
| Portfolio, wallet, chat history, B2B desk | Read from the last state the device stored. |
| Prices | The last quote received for each ticker is replayed from the device cache and labelled as cached. Prices cannot move without a feed — that is a market fact, not an app limit. |
| Trading / investing | The trade ticket works against the cached book, as before. Orders placed offline stay on the device and reconcile with the server when the connection returns. |
| B2B price alerts | Evaluated **on the device** against the cached quotes. Buy/sell hits raise a normal device notification with vibration, on the home screen and the lock screen. |
| Notifications | `reg.showNotification` from the service worker — works with no network while the app process is alive, and from the Android periodic background sync while the app is closed. |

## What still needs a connection

* **New** live prices, other users' messages, and server-side balances changes.
* **Server-side** alert email (Brevo) and server push — a server cannot reach a
  device that has no network. The device-side check covers that case instead.
* A browser/PWA can be killed by Android when it is in the background. In that
  state only the OS periodic background sync (Chrome/Android, min. 15 min) or the
  bundled Android APK can wake it. The APK has no such limit.

The app never blocks on a network call to start: every `/api/*` `GET` falls back
to the device cache, and `navigator.onLine === false` short-circuits straight to
the cache instead of waiting for a timeout.

## How the pieces fit

```
public/offline-first.js   device runtime: precache, API cache, alert engine, prompt
public/sw.js              shell + api cache, push, periodic background alert check
scripts/prepare-assets.js injects the runtime and writes offline-manifest.json
scripts/test-offline.js   fails the build if anything needed offline is missing
```

The runtime stores everything in IndexedDB `wc-offline`:

| Store | Contents |
| --- | --- |
| `api` | last successful `GET /api/*` body, keyed by path+query, 7-day retention |
| `meta/alertSnapshot` | alerts + last known prices, read by the service worker |
| `meta/alertHits` | dedupe keys so a target is never notified twice |

## B2B auto buy/sell email (Brevo)

The server watcher (`b2b-alerts.js`) already mails on every buy/sell hit through
`email.js`. Brevo is selected automatically when `BREVO_API_KEY` is set.

```bash
BREVO_API_KEY=xkeysib-...        # Render dashboard → Environment (secret)
MAIL_FROM=whalechat1@gmail.com   # must be the verified Brevo sender
MAIL_FROM_NAME=WhaleChat
```

Check it without sending a trade:

```bash
curl -s https://<service>.onrender.com/api/health | jq '.email'   # must be true
curl -s https://<service>.onrender.com/api/email/status | jq
```

If `MAIL_FROM` is not the verified sender, `email.js` falls back to
`whalechat1@gmail.com` and logs a warning — the mail still goes out.

## Verifying a release

```bash
npm run build          # assemble + inject + manifest
npm run test:offline   # fails if the installed app would miss a file
npm start
```

Then in the browser: DevTools → Application → Service Workers → Offline, reload.
The app must open, show the last portfolio/chat/prices, and still evaluate alerts.

## Verifying Brevo for real

`scripts/test-brevo.js` sends one actual B2B alert email through the same code
path the alert watcher uses (`email.js` → `b2bAlert` template → Brevo).

```bash
BREVO_API_KEY=xkeysib-... npm run test:brevo -- --to=you@example.com
```

Expected output ends with `{ queued: 0, sent: 1, failed: 0 }`. The verified
sender on this Brevo account is `whalechat1@gmail.com` (active); `MAIL_FROM`
must be that address or `email.js` falls back to it.

## Deploying

The repo is the source of truth; `main` is what a host builds.

```bash
RENDER_API_KEY=rnd_... BREVO_API_KEY=xkeysib-... npm run deploy:render
```

The script finds (or creates) the `whalechat` web service, writes the runtime
secrets into its environment, deploys `main`, follows the deploy and prints the
`/api/health` summary — `email: true` confirms Brevo is live.

If Render answers `402 billing_suspended`, the service cannot be created or
deployed until the account's billing is settled; that is an account state, not a
build failure.
