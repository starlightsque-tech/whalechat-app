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

## Local-first data (IndexedDB v2)

`public/offline-first.js` owns the schema (`wc-offline`, version 2) and
`public/offline-data.js` fills it. Chat and shop history stay readable and
searchable with no network:

| Store | Key | Contents |
| --- | --- | --- |
| `messages` | id (+ `chatId`, `createdAt` indexes) | last 3 000 messages |
| `chats` | chatId | last activity per conversation |
| `profiles` | id | usernames, names, avatars |
| `products` | id | catalogue with prices and stock |
| `cart` | productId | the live cart |
| `orders` | id | last 300 orders/receipts |
| `outbox` | auto id (+ `status`) | actions performed offline |

Offline search: `WC_OFFLINE.searchMessages('invoice')` resolves with matching
stored messages, newest first.

## The outbox

`App.send`, `App.addToCart`, `App.cartQty`, `App.cartRemove` and `App.clearCart`
are wrapped. While `navigator.onLine` is false each action writes one row to
`outbox` and marks the local object:

* chat messages get a **“Waiting for network”** badge inside the bubble
* the cart page gets a “cart changes waiting for network” note

On reconnect the queue is replayed **in creation order** and then deleted, with a
single state push for the whole batch. Handlers set an *absolute* end state
(`cart-set` carries the resulting quantity, not a delta), so a double flush can
never double a cart line.

## Offline checkout

`App.placeOrder` is guarded: offline it returns `false` and shows a calm notice —
*“Payment needs a connection — your cart is saved on this device”* — and the Pay
button is disabled with an inline explanation. Nothing is charged and the cart,
delivery details and invoice stay in IndexedDB. The guard is removed
automatically when the connection returns.

## Connectivity

`#wcNetPill` sits above the safe area, shows `Offline · N waiting` while
disconnected, `Syncing N changes…` during a flush, and disappears by itself
2.6 s after everything is synced. It never blocks taps (`pointer-events:none`).

## Hidden diagnostics

`public/diagnostics.js` — not linked anywhere in the UI. Open it by:

* visiting `#/diagnostics` (or `#/diag`)
* tapping the WhaleChat logo **5 times quickly**
* `Ctrl/Cmd + Shift + D`
* `WC_DIAGNOSTICS.open()` from the console

It reports the service worker state, every cache with its entry count, the total
number of files cached, IndexedDB API-cache entries with size and newest/oldest
age, the mirrored message/chat/profile/product/cart/order counts, outbox depth,
the last alert evaluation, notification permission and push subscription, storage
usage/quota and the cached build manifest. Buttons: re-check, run an alert check
now, copy the JSON report, clear the offline API cache.

## Tests

```bash
npm run build
npm run test:offline          # static: manifest, SW wiring, schema, bundle, manifest
npm i -D jsdom fake-indexeddb
npm run test:offline:runtime  # integration: offline send, outbox, flush, pay guard
```

The runtime harness boots the real modules in jsdom, sends a message and changes
a cart with `navigator.onLine === false`, asserts the queue and the badges, then
reconnects and asserts the queue drains once with the correct cart quantity.

## Offline message search

`public/message-search.js` (`WC_MSG_SEARCH`) searches chat history with no
network. Two sources are merged and de-duplicated:

1. `window.DB.messages` — the live conversation store, instant
2. the IndexedDB mirror through `WC_OFFLINE.searchMessages()` — survives a
   reload and covers history no longer in memory

Results show the conversation, a highlighted snippet, the sender, the time and
an **“on device”** marker when the hit came from cached storage. Tapping a result
opens that conversation.

Entry points: the magnifier in the **Chats header** (next to people search), the
magnifier in a **chat room header**, `Ctrl/Cmd + F` inside a chat, or
`WC_MSG_SEARCH.open('invoice')`.

## Device mode — money, investing, trading

`public/offline-actions.js` keeps the money surfaces working offline and is
explicit about what a device cannot do alone.

| Works offline (recorded on device, synced on reconnect) | Needs the server (calm explanation, no dead button) |
| --- | --- |
| Stock / market investing trades (local engine settles, reconciles later) | Spot order tickets (`/api/market/spot/*`) |
| Deposit requests (reviewed requests, not instant charges) | WhaleChat Shares plans |
| Withdrawal requests + balance hold | Bot marketplace |
| Transfers to another WhaleChat account | Live Finnhub symbol search |
| Cart, delivery details, chat, alerts, wallet history, statement | Payment capture at checkout |

Each queued money action also writes an outbox row (`money`), so the state push
is retried on reconnect even if the tab was closed. Spot tickets show an inline
notice and point to Invest, which does work offline.

A **Device mode** notice appears at the top of wallet / deposit / withdraw /
transfer / checkout / invest pages while offline, naming exactly what is saved
locally and what happens on reconnect.

## One search box for everything on the device

The Chats screen carries a single search field — *“Search messages, products,
orders, wallet”* — plus magnifiers in the Chats and chat-room headers and
`Ctrl/Cmd + F` inside a conversation (`WC_SEARCH.open()`). Results are grouped
by type with a count per group:

| Group | Matches on | Opens |
| --- | --- | --- |
| Messages | message text | that conversation |
| Products | name, category, description, ticker | the product page |
| Orders | order ref/id, status, item names | Orders / tracking |
| Wallet | transaction label and type | Wallet |

Each result is tagged **on device** when it came from IndexedDB rather than the
live store, and every row deep-links with `data-wcgo`. The search is local in
both modes — online it reads the live store first and falls back to the mirror,
offline it reads only the mirror — so the same query returns the same shape with
or without a connection.

Wallet history is mirrored into the `txs` store (schema v3) alongside messages,
chats, profiles, products, cart and orders.

## Data layer: Supabase Postgres

The Node sync service cannot run on Supabase (Supabase has no long-running
process host — only Postgres, Auth, Storage, Realtime and Deno edge functions).
What Supabase does here is the durable database, which is the part that mattered:
on Render's free plan `DATA_DIR` is wiped on every restart.

* Project: `whalechat` (`eiikmbuzxfnsmtcrfgut`, eu-west-1, PG 17)
* Role: `whalechat_app` — a dedicated login with `usage, create` on `public` plus
  default privileges for future tables. The `postgres` superuser password was
  **not** changed.
* Connection: Supavisor pooler, session mode (`aws-1-eu-west-1.pooler.supabase.com:5432`),
  TLS required, set as `DATABASE_URL` in the Render environment.
* Schema is created on boot: `whalechat_state`, `whalechat_market_config`,
  `market_provider_config`, `tradable_symbols`, `trading_controls`,
  `admin_logs`, `market_price_cache`.

Managed Postgres note: `node-postgres` merges the parsed connection string over
the client config, so `?sslmode=require` re-enables certificate verification and
fails with *self-signed certificate in certificate chain*. `initStorage()` strips
`sslmode` and sets `rejectUnauthorized: false` explicitly for managed hosts.

Verify:

```bash
curl -s https://<host>/api/health | jq .storage   # "postgres"
```

## Supabase: pause behaviour, keep-alive, backup

See **[docs/BACKUP.md](BACKUP.md)** for the full detail. Summary:

* A free project pauses after **7 days without project activity**; the app writes
  a heartbeat every 5 minutes while it is awake and a GitHub Actions job touches
  the project every 6 hours.
* Cold or just-resumed connections can fail; the service retries with backoff,
  keeps serving chat/alerts from memory, and reconciles by `rev` on reconnect
  (newer side wins — never a blind overwrite).
* `whalechat_state` is exported daily to `backups/whalechat-state-YYYY-MM-DD.json`
  by `.github/workflows/backup.yml`, retained 14 days as a workflow artifact.
* Restore with `node scripts/restore-state.mjs --file=… --yes`, then restart the
  service. The current row is saved to `*.pre-restore.json` first.

## Asset tickers, trade tickets and B2B history

**Dotted / underscored tickers.** Some listings carry an internal ticker with a
non-alphanumeric character — Toyota is `7203_T` while the UI shows `7203.T`.
The stock page mounts its trade ticket from the URL hash, and the old matcher
(`[A-Z0-9.]+`) truncated `7203_T` to `7203`, so `INV.stock()` returned null and
the ticket area stayed empty. Now:

* the hash matcher accepts `[A-Za-z0-9._-]`
* `LT.resolveStock()` resolves a ticker by `ticker`, `displayTicker` or
  `finnhubSymbol`, normalising punctuation
* if a symbol still cannot be resolved the page's own panel is left untouched
  instead of being removed

Every asset page therefore shows the full ticket: capital, Rise/Fall, take
profit / stop loss, duration and the per-trade leverage select (`#ltLev`, 1×–20×
effective), and `LT.start()` reads that select so the chosen leverage is stored
on the trade.

**B2B-Investing history** (`#/investment/history/b2b`) lists every fill:

| Source | Shown as |
| --- | --- |
| Manual buys (`App.ihB2bBuy`) | `▲ Buy TICKER` |
| Manual sells (`App.ihB2bSell`) | `▼ Sell TICKER` |
| Auto Buy/Sell buys and sells (server watcher) | `▲ Buy` / `▼ Sell` with an **AUTO** badge |

The block merges three sources — the new `investAcct.b2bTrades` journal, the
server's `b2bAutoJournal`, and qualifying ledger lines — de-duplicated by id, so
a whole-DB sync overwriting one of them cannot hide a fill.

Verified by `npm run test:ui` (jsdom boots the built bundle, opens Toyota, clicks
Buy and asserts the stored leverage, then renders the B2B history page).

## Chat and contacts with no connection (3.77)

The installed app is offline-first for conversations, not just prices:

| Action with the network completely off | What happens |
| --- | --- |
| Add someone to your contacts | Saved on the device immediately (`DB.contacts`, one row per owner+person). The add is pushed to the server on the next successful sync and can never be erased by a refresh (`wc-contact-fix`). |
| Send a message | The bubble renders at once, the message is written to IndexedDB + the Outbox, and a clock tick shows it is waiting. The Outbox drains on reconnect (2 s loop, 5/10/30 s retries). |
| Read the conversation | The cached transcript opens first, so history is readable with no signal. |
| The other person adds you back / replies | One-way add is enough: they can open the conversation, read it, reply, and are saved to your contacts automatically. |
| Both users see each other's messages | After **one** of the two devices reconnects, the queued message reaches the server; the other device receives it over Realtime (or its poll/SSE fallback) and it appears in the transcript exactly once. |

**The honest limit:** two phones that are *both* offline, with no shared network of any kind, cannot
exchange data — there is no radio path between two browsers. "Offline chat" in WhaleChat means the
app never blocks on the network: you can add contacts, write, and read while offline, and the
messages are delivered the moment either device has a connection. Messages are never lost and are
never duplicated (the message id is the Appwrite document id).

### Verified automatically

```bash
npm run test:chat-e2e        # two independent clients: send, go offline, exchange, reconnect
```

`scripts/test-chat-e2e.mjs` drives the real `wc-live-chat.js` module: both clients go offline,
exchange messages, reconnect, and the suite asserts the messages arrived exactly once on each side
and the outboxes are empty afterwards.
