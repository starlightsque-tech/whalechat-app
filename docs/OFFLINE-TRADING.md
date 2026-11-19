# WhaleChat 3.64.0 — offline mode, native charts and deterministic trade reconciliation

This release keeps every existing integration (Chat, Shop, Get Paid, Appwrite,
Finnhub, Twelve Data, Binance, Brevo) and adds a single trading engine that
works with or without a connection.

## What was added

| Area | File | Purpose |
|---|---|---|
| Server config | `server-config.js`, `public/wc-server-config.js` | one place for the Appwrite NYC project, Binance stream, Telesign, Brevo and the reconciliation tolerance. Secrets stay in the environment; only public ids ship in the bundle. |
| Device database | `public/wc-device-store.js` | IndexedDB (`wc-device`): portfolio, holdings, orders, `pending_sync`, OHLCV candles, watchlist, meta. Falls back to memory if IDB is blocked. |
| Installed-app gate | `public/wc-install-mode.js` | strict standalone detection (`display-mode: standalone`, `navigator.standalone`, Capacitor). Browser tabs get an install prompt instead of offline trading. |
| Simulator | `public/wc-sim-engine.js` | GBM micro-ticks seeded from the last **real** close, volatility from cached candles, bid/ask spread, 1-minute bars, downtime replay. |
| Native chart | `public/wc-native-chart.js` | canvas candlesticks + line + volume + crosshair, provider candles from Finnhub/Twelve Data/Binance, and the `LIVE MARKET` / `OFFLINE SIMULATED` badge. |
| Client reconciliation | `public/wc-recon.js` | FIFO push on `online`, focus, visibility and Background Sync; applies `RECONCILED` / `ADJUSTED` / `OPEN` / `FAILED_*`; rolls optimistic balances back. |
| Trading desk | `public/wc-offline-desk.js` | market / limit / stop-loss, watchlist, portfolio analytics, cash⇄wallet transfer, order history badges — identical online and offline. |
| Server reconciliation | `offline-orders.js` + `/api/orders/offline/*` | the authority: idempotency, tolerance, live adjustment, OPEN conversion, insufficient-funds protection, Brevo receipt. |
| Appwrite backend | `appwrite-function/offline-sync.js` + function routes | the same rules when the app is hosted on Appwrite Sites (no Node server). |
| Telesign | `telesign.js` + `/api/telesign/*` | server-signed SMS OTP + SMS notifications. Credentials never reach the browser. |
| Appwrite orders | `appwrite-orders.js` | idempotency lookups and order mirror into the `offline_orders` collection. |

## Reconciliation rules (server is the authority)

1. **FIFO** — `pending_sync` is processed oldest `offlineTimestamp` first.
2. **Idempotency** — `clientOrderId` (UUID v4) is checked in the local ledger and
   in Appwrite before anything is written. Duplicates are marked `RECONCILED`.
3. **Market orders**
   * `|offline − live| / live ≤ 2%` → honour the offline price, `RECONCILED`.
   * `> 2%` → fill at live and re-derive the quantity from the committed
     notional, `ADJUSTED`; both prices are stored.
4. **Limit / stop-loss**
   * trigger met → fill at the live/limit price, `RECONCILED`.
   * not met → convert to a live `OPEN` order and track the reservation.
5. **Insufficient funds** → `FAILED_INSUFFICIENT_FUNDS`, nothing is written, the
   device rolls its optimistic balance back.
6. **Brevo** → one consolidated receipt per batch that settled at least one
   trade, listing asset, quantity, offline timestamp, final price and balance.

## Build & test

```bash
npm run build                     # assembles public/whalechat.html and stamps the release
npm run test:offline-trading      # 17 checks: engine rules + jsdom/IndexedDB client
npm run test:offline              # installed-app offline shell
npm run verify:connections       # provider configuration report
```

`npm run test:offline-trading` needs `jsdom` and `fake-indexeddb`; they are
declared as devDependencies.

## Deploy

```bash
# 1. Appwrite database + collections (idempotent)
APPWRITE_API_KEY=... npm run deploy:appwrite:db

# 2. Sync function (offline reconciliation + verification mail)
APPWRITE_API_KEY=... npm run deploy:appwrite:function

# 3. Static site (public/) to Appwrite Sites
APPWRITE_API_KEY=... npm run deploy:appwrite
```

The function reads `APPWRITE_DATABASE_ID` (default `whalechat`) and
`WC_OFFLINE_COLLECTION` (default `offline_orders`). Quotes come from Binance
(crypto, no key), Finnhub and Twelve Data when their keys are set as function
variables.

## Environment

See `.env.example`. Nothing in this repository contains a key; the Appwrite
project id is public by design. Telesign credentials are server-only, and the
app talks to `/api/telesign/*` which signs the Telesign request with HTTP Basic
auth.
