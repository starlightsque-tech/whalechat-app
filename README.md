# WhaleChat 3.29.0 — web app + mobile apps

WhaleChat is a social + marketplace + wallet product built as a single-page app with a
Node sync server and native Android/iOS shells.

**Live (HTTPS):** https://tremendous-homeland-benjamin-challenge.trycloudflare.com
**Admin:** `Admin` / `Admin@12345` — change immediately in *Payment Settings → Admin security*.

> The live URL is a Cloudflare quick tunnel served from this sandbox. It is HTTPS with a valid
> certificate but the hostname is temporary. For a permanent domain use the Docker/Render
> options below — the app itself is unchanged.

---

## What's in here

```
public/                 the web app (served by server.js)
  index.html            branded entry + referral routing (/ref/CODE, /r/CODE, ?ref=)
  whalechat.html        the entire app (self-contained, 684 KB)
  manifest.webmanifest  PWA manifest (installable on Android / iOS / desktop)
  sw.js                 offline shell + push + in-place updates
  assets/               logo, launcher icons, maskable icon, splash art
  version.json          build manifest used by installed apps to self-update
server.js               sync API + static host (state, ops, SSE, push, backups)
scripts/build-mobile.mjs  copies public/ → mobile bundle, bakes sync URL
mobile/
  capacitor.config.json Capacitor config (appId app.whalechat.mobile)
  android/              full Gradle project — builds a signed APK
  ios/                  Xcode project — builds on macOS
  www/                  generated mobile bundle (do not edit)
whalechat-release.apk   signed release APK (v3.2.0, code 6)
Dockerfile · docker-compose.yml · Caddyfile · render.yaml
```

## Market data (Finnhub + 24/7 OTC fallback)

`Admin → Stocks → Market data · Finnhub` stores three server-side settings:

| Setting | Purpose |
|---|---|
| **Finnhub API Key** | Kept only in `DATA_DIR/market-config.json` (mode 0600). It is never written to the synced app database and never sent to browsers. |
| **Data mode** | `Hybrid (Live Finnhub + 24/7 Simulated Fallback)` or `Simulated Only`. |
| **Refresh interval** | Seconds between REST refresh/status cycles. Default **15**. |

In **Hybrid** mode the backend seeds `AAPL, TSLA, NVDA, COIN, MSTR, MARA, KO, JPM, NKE, UNH, AVGO, WMT, DIS, V, UBER, AMZN`
through Finnhub's `/quote` endpoint **1.2 seconds apart** (under the 60 calls/minute free-tier limit), then opens one shared
WebSocket to `wss://ws.finnhub.io` and subscribes every symbol. Prices are cached in server memory and every browser reads
`GET /api/market/quotes`, so users never call Finnhub directly.

The fallback engine runs automatically when the US market is closed, Finnhub returns HTTP `429`, or WebSocket ticks stop:
the server keeps producing smooth micro-ticks from the **last real Finnhub close**, so virtual Rise/Fall trades stay live
24/7 with no frozen charts. The market notice switches between **“Live market data via Finnhub”** and
**“24/7 OTC market mode active (based on last real close)”**.

Live trades on covered symbols are also settled by the backend every few seconds (take-profit, stop-loss, duration expiry),
so Whale Coin payouts and notifications happen even if every browser tab is closed.

Every Rise/Fall trade can carry optional **Take Profit (TP)** and **Stop Loss (SL)** levels, entered as a
percentage move or an exact USD target price. The trade form validates the side (Rise: TP above entry, SL
below; Fall: TP below entry, SL above), open trades can edit or clear their levels from Active Trades, and
the chart draws `Entry` / `TP` / `SL` price lines with `createPriceLine()` until the trade closes. The same
lightweight-charts baseline view is used on the portfolio performance card, with the live/OTC mode notice.

The stock detail chart uses TradingView **lightweight-charts** `BaselineSeries` loaded from unpkg. Its baseline is the exact
trade entry price for an open Rise/Fall position (green above / red below, inverted for Short), with `timeVisible: true`
and `secondsVisible: true` and per-tick `series.update()` — no reloads.

TP/SL can be entered as a **percentage**, an exact **USD price**, or a **WC amount** target. Trailing stops
ratchet behind favourable price movement and only tighten. Open-trade cards and closed-trade history show the
levels that were set, and the chart's `Entry` / `TP` / `TSL` lines follow a trailing stop as it moves.

Environment variables (optional, useful for first boot): `FINNHUB_API_KEY`, `FINNHUB_MODE=hybrid`.
For provider testing only: `FINNHUB_REST_BASE`, `FINNHUB_WS_URL`, `FINNHUB_SEED_DELAY_MS`, `US_MARKET_FORCE_OPEN=1`.

**Verify a live key end-to-end** (on the server host, after `npm install`):

```bash
FINNHUB_API_KEY=your_key node scripts/verify-finnhub.js
npm run verify:finnhub          # same, uses FINNHUB_API_KEY from the environment
```

## Stock trading flows (Rise/Fall + Spot) — 3.23.0

Every listed stock has **two independent flows** on the same live Finnhub quote:

1. **Rise / Fall (leveraged, existing)** — stake, direction, duration, optional TP/SL,
   trailing stop; settled server-side by `market.js`.
2. **Spot investment (new)** — buy real shares at the live market price and sell them
   back at the live market price.

### Spot buy / sell

`POST /api/market/spot/buy` accepts `userId`, `ticker` and **one** of
`amountCoins` (WC), `amountUsd`, or `shares`, plus optional `tpPrice` / `slPrice`.

* Execution price is the current live Finnhub quote — **no markup**.
* The admin profit rate for the stock is **locked on the position at purchase**.
* The total cost is deducted from the wallet in the same synchronous step that stores the
  position, so a failed request can never leave a free position behind.
* A position records `Symbol`, `Entry Price`, `Quantity`, `Invested Capital`,
  `Profit Rate`, `Take Profit Price` and `Stop Loss Price` in `db.holdings` (`kind: "spot"`).
* Every buy is written to `db.trades` (`type: "spot"`, `status: "Completed"`).

`POST /api/market/spot/sell` with `userId` + `ticker` closes the position and pays the
locked rate and the live market gain:
`profit payout = (invested capital + market gain) × profit rate ÷ 100`, then
`credit = invested capital + profit payout`. Example: capital 100 WC, market gain 1.2 WC,
rate 10% → profit 10.12 WC, total credit 110.12 WC.

The payout is credited to the wallet and the sell is written to Order History
(`#/invest/orders`). Finnhub live prices drive the market gain and TP/SL triggers.

`POST /api/market/spot/tpsl` updates or clears (`0`) the TP/SL levels on an open position.

### Automated Take Profit / Stop Loss

`spot.js` runs a 1-second worker:

* **Take Profit** — `live price >= takeProfitPrice` → close position.
* **Stop Loss** — `live price <= stopLossPrice` → close position.

Either exit pays the same locked admin profit rate — the live price only decides *when*
the position closes.

The sell path is a **fully synchronous critical section**: it re-reads the position,
removes (or trims) it, then credits the wallet. A manual sell racing the TP/SL worker
therefore cannot double-credit — the loser sees `No open position`. Notifications and
transaction records are created for every automated exit.

### Live trade controls & bot performance (3.24.0)

**Take Profit is a skim, not a close.** When a trade's TP level is reached (or the user
presses **Take profit** while the trade is in profit):

* the open profit is credited to the wallet immediately,
* the position is re-based to the current price,
* the consumed TP level is cleared,
* the trade **keeps running** until the timer expires, the stop loss is hit, or the user
  presses **Stop trade**.

The **Take profit** button is disabled unless the trade is currently in profit. The new
middle **Stop trade** button closes the trade immediately and returns capital + open P/L.
**Take loss** is disabled unless the trade is currently losing; pressing it (or an
automatically hit stop loss) closes the trade.

Manual take-profit uses `POST /api/market/trade/take-profit`, which performs the skim
server-side so a click racing the settlement worker cannot double-credit. The backend
worker also skims automatically on TP hits while the app is closed.

**Bot performance on the portfolio chart.** The main Invest → Portfolio performance chart
now includes the running trading bot's equity: it starts at the allocated capital and
steps with every simulated bot trade. The hero totals (portfolio value, invested,
earnings), allocation donut and positions list include a “Trading Bot” row, and the bot
card shows live P/L, trade count and the latest bot trade. The dashboard polls bot state
every 8 seconds so the chart, earnings and activities stay current.

### Bulk profit rate per market type

Admin → **Stocks** → **Bulk profit rate by market type**: pick **US Stocks**, **Global Stocks**,
**Forex**, **Crypto** (or **All market types**), enter an ROI percentage and press
**Apply to all stocks**. Every stock in that type gets `profitPct` immediately — e.g.
*Crypto + 1.5%* makes every crypto pair pay exactly 1.5% profit on close.

* The bulk rate is also stored as `db.invest.classRates[type]`, so **newly listed stocks inherit it**.
* A single stock can still override the class rate in Add/Edit stock (leave the field blank to inherit).
* Existing open positions keep their locked rate; only new buys use the new rate.

### Rise / Fall direction semantics

* **Rise (long):** profit while the chart moves **up** (green zone above entry), loss while it
  moves **down** (red zone). P&L = stake × leverage × % move × +1.
* **Fall (short):** profit while the chart moves **down** (green zone below entry), loss while
  it moves **up** (red zone). P&L = stake × leverage × % move × −1.
* The stock chart baseline colours are inverted for Fall trades, so green always means the
  user's profit zone and red means the loss zone.
* The order ticket, active-trade card and stock chart now state the prediction explicitly
  (“Rise — profit while price rises” / “Fall — profit while price falls”) with the live P&L.
* Direction is authoritative (`trade.direction`), so both the browser fallback and the
  server settlement apply the same sign; a wrong prediction loses in proportion to the move
  (loss capped at the stake).

### Asset-class visibility (admin)

Admin → **Stocks** → **Asset classes shown on the app** has four switches:
**US Stocks**, **Global Stocks**, **Forex** and **Crypto**. Turning a class off:

* removes it from the Market page cards, category chips, search results and watchlist,
* blocks new spot buys for that class on the backend (`This asset type is currently turned off`),
* keeps existing positions/orders visible so users can still close them,
* leaves Finnhub live prices untouched for every enabled class.

The setting is stored in the synced database (`db.invest.classes`) so every device and the
server enforce the same set immediately.

### Admin profit rate per stock

Admin → **Stocks** → the **%** button (or Add/Edit stock) sets `profitPct` per stock
(0–500%). The rate is locked when a user buys and paid exactly on close:
`profit = (capital + market gain) × rate`, paid on top of the returned capital. Every
chart, quote and TP/SL check keeps using the raw live Finnhub market price — the live feed is display/trigger only and real stocks are
never altered. Rate changes apply to new positions; open positions keep their locked rate.

### Trading bots (restored)

`bots.js` + `public/trading-bots.js` provide the four bot tiers, admin-editable pricing,
subscriptions, reserved capital and a server-side worker that keeps trading while the app
is closed. Admin → Stocks includes the bot configuration panel. Endpoints:
`/api/bots/state`, `/api/bots/subscribe`, `/api/bots/start`, `/api/bots/stop`,
`/api/bots/admin`, `/api/bots/admin/config`.

**Bot profiles, health engine and performance page (3.30.0).** Every tier is a full trading
identity with a profile picture (`public/bots/*.jpg`, admin-overridable with an uploaded photo):

- `#/bots` — all bot identities as cards (avatar, `@username`, accuracy, price, HOT/Owned).
- `#/bots/<tierId>` — profile page: large picture, accuracy, subscription state, health, energy,
  net P/L and trade count, a per-bot equity chart, session history and subscribe / start / stop /
  cool-down actions.
- **Cooling** — `POST /api/bots/cool` stops the session, stores `db.botCooldowns[userId]`, and the
  UI shows a live `m:ss` countdown until the bot is ready again. Cooling also restores energy so
  the next session trades closer to its target accuracy.
- **Health engine** (`BotService.healthEngine`) — derives `state` (`thriving` / `stable` /
  `fatigued` / `cooling` / `idle`), score, energy, stamina band, win rate, drawdown and the
  cooldown deadline, plus the 40-point health history sparkline. Exposed as `health` in
  `GET /api/bots/state` and rendered as its own card on the bot, profile and performance pages.
- **Performance page** — `#/invest/bots/performance`: net bot P/L, ROI on allocated capital,
  win rate, trades/sessions, a Lightweight Charts v5 equity curve (`WC_PRO_CHART.mountEquity`)
  with a break-even line, the health engine, the cooling banner and a per-session table with
  avatars. Aggregation is computed server-side in `BotService.performance` from every session's
  trade log (`poolAfter`, `pnlCoins`) and exposed as `performance` on the bot state.

### Auto Secure Take Profit (bot tool)

A dedicated bot tool users can subscribe to (default **$20 / month → 40 WC**, stored in
`db.botSettings.autoSecurePriceUsd` / `autoSecureCycle`). While enabled it watches every open
live trade server-side — even with every app closed — and whenever meaningful profit is
available it **secures** it:

* the profit is written to `trade.securedProfits` (amount, price, timestamp) and the
  position is re-based, so the secured amount cannot be lost by later price movement,
* **nothing is credited yet**; the trade keeps running,
* if a TP level triggers while Auto Secure is on, that profit is queued the same way
  instead of being auto-credited,
* the user sees a **Secured profits** card on the Invest dashboard and Orders page and
  presses **Take profit** on each entry to credit it (`POST /api/market/secure-profit/claim`).

**Visibility & claiming.** The Invest dashboard hero has a live **Secured profit** tile with
the pending total and entry count, refreshed by `LT.paintDash` every couple of seconds; the
bot card and Trading Bots page show the same counters. The **Secured profits** card has a
**Claim all** button (plus the existing one-by-one Take profit buttons) so every pending entry
can be credited at once.

**Admin controls.** Admin → Stocks → Trading bots now has **Auto Secure price (USD)** and
**billing cycle** fields, plus live stats for Auto Secure subscribers and revenue. Changes in
`db.botSettings.autoSecurePriceUsd` / `autoSecureCycle` apply to new subscriptions and renewals.

Endpoints: `/api/bots/auto-secure/subscribe`, `/api/bots/auto-secure/toggle`,
`/api/market/secure-profit/claim`, `/api/market/secure-profit/claim-all`.
The Auto Secure worker scans every **1 second** (and immediately after the tool is turned on),
securing any profit of at least **0.01 WC**, with a 2-second per-trade cooldown so entries stay
meaningful. Secured amounts are re-based out of the position, so later price movement can never
take them back.

### WhaleChat share investment portfolio (restored)

`shares.js` + `public/whalechat-shares.js` provide admin-defined investment plans
(min/max, duration, % return), real-time accrual, automatic maturity payout and the
`#/invest/shares` dashboard, plus a summary card on the Invest dashboard. Endpoints:
`/api/shares/state`, `/api/shares/invest`, `/api/shares/admin`, `/api/shares/admin/plans`.

### Local verification

```bash
node scripts/prepare-assets.js   # assemble whalechat.html + inject the modules
PORT=8091 DATA_DIR=/tmp/wcdata node server.js
```

The backend exposes `/api/market/spot/positions?userId=…` for a quick position/worker
status check, and `/api/health` reports the market feed and service state.

### Smooth live charts (3.24.1)

The backend quote poll arrives every ~2.5 s. Instead of snapping, the app now animates each
displayed price from the previous tick to the new tick over an 850 ms ease-out window. The
last point of the active lightweight-chart (stock chart and portfolio chart) is updated in
place, and price/percentage labels are repainted at ~10 fps, so the trade view moves
smoothly while server settlement and TP/SL continue to use the authoritative quote.

## Shared portfolio audit trail

While a manager is inside a shared portfolio link, every action is recorded in
`db.portfolioAudit` (synced to the server) and shown in a **Portfolio activity** card on the
Invest dashboard for the owner:

* live trade opened / closed / take-profit / stop / secured-profit claim,
* spot stock buy / sell / TP-SL updates,
* WhaleChat investment plan purchases,
* bot subscribe / start / stop and Auto Secure subscribe / toggle.

Entries store the owner, the action, a short detail, the manager label and a timestamp, so the
owner can review exactly what was done through the shared link.

## Market movement for every stock

When Finnhub ticks are unavailable (no API key, market closed, rate limit or a quiet
WebSocket) the backend now generates a **24/7 fallback tick every 2 seconds** for every
asset class and seeds an intraday history tail. US stocks and global stocks therefore always
have a price, volume and a moving trade-view chart; real Finnhub prints take over the moment
they arrive. Symbols with no stored price get a deterministic base price.

## Shared stock portfolio (username-only manager access)

Every user can share their stock portfolio from **Invest → Share stock portfolio**.

* The link looks like `https://your-app/#/portfolio/<token>` and is stored on the user as a
  random `portfolioToken` (reset the link at any time to revoke access).
* The visitor opens the link, enters the **owner's username only** (no password) and gets a
  restricted session:
  * allowed: **Invest** (dashboard, market, stock pages, orders, watchlist),
    **WhaleChat investment plans** and **Trading Bots**;
  * blocked: home/chat/marketplace, wallet, profile, notifications, deposits and withdrawals;
  * trades, plan subscriptions and bot subscriptions use the owner's balance.
* A visible **Portfolio manager mode** banner and **Exit portfolio** buttons are shown; the
  visitor's previous login is restored on exit. Token resets invalidate active sessions.
* Money actions are blocked in the client, and the restricted routes redirect to Invest.

## Readability

Global text sizing and contrast were raised for readability: larger `.tiny`/`.small` text,
stronger muted colours in both themes, clearer labels, chips and buttons. This applies
everywhere, including the shared-portfolio screens.

## Desktop / Mobile view

The app now opens in **Desktop view by default** and has a view switch:

* **Topbar button** — monitor/phone icon, switches between views.
* **Sidebar button** — “Switch to mobile view” / “Switch to desktop view”.
* Choice is remembered per device in `localStorage` (`wc.viewMode`).

**Desktop view on a phone** sets the viewport to a 1280px layout width, so the real desktop
UI (sidebar, wide grids) is used and scaled to the screen. **Mobile view** uses the normal
responsive layout; on a desktop screen it frames the app in a centred 480px phone-style
column with the bottom navigation. Toggling on a phone reloads once so the new viewport
width applies cleanly. Both modes dispatch resize events so charts re-measure.

## Run locally

```bash
npm install          # only needed for push (web-push); the server itself has no hard deps
npm start            # http://localhost:8090
```

Environment: `PORT` (8090), `DATA_DIR` (./data), `PUBLIC_URL`, `VAPID_EMAIL`, `BACKUP_KEEP` (48).
`DATA_DIR` holds `state.json`, VAPID keys, push subscriptions and hourly snapshots
(`data/backups`, auto-restored if `state.json` is missing).

## Deploy with HTTPS

**Docker + Caddy (automatic Let's Encrypt):**

```bash
cp .env.example .env        # set DOMAIN=chat.yourdomain.com, PUBLIC_URL=https://chat.yourdomain.com
docker compose up -d --build
```

**Render:** push the repo, New → Blueprint, `render.yaml` mounts a 1 GB disk at `/var/data`.
Health check: `/api/health`.

**VPS + systemd:** copy to `/opt/whalechat`, `npm install --omit=dev`, install a unit with
`DATA_DIR=/var/lib/whalechat`, put Caddy/Nginx in front (do not buffer `/api/events`).

**Cloudflare Tunnel:** `cloudflared tunnel --url http://localhost:8090` for a quick host,
or a named tunnel bound to your domain for a permanent one.

## Mobile apps

**Android** — the signed APK is `whalechat-release.apk` (installs on Android 5.1+, target SDK 34).
Rebuild after changes:

```bash
cd mobile
npm install
WC_SYNC_SERVER=https://your-domain npm run bundle   # or: npm run sync
cd android && ./gradlew assembleRelease
apksigner sign --ks <keystore> app/build/outputs/apk/release/app-release-unsigned.apk
```

The checked-in Android project was built with JDK 17 / SDK 34 and signed with a local
development keystore (not included). Generate your own before publishing:

```bash
keytool -genkeypair -keystore whalechat.jks -alias whalechat -keyalg RSA -keysize 2048 -validity 10000
```

**iOS** — `mobile/ios` is a complete Xcode project; on macOS run `npm run sync && npx cap open ios`,
set a signing team, then Archive → App Store Connect. Icons and splash are already generated
(`AppIcon-512@2x.png`, `splash-2732x2732.png`).

**PWA** — open the HTTPS URL on a phone and choose *Add to Home Screen*. Push requires the
installed app on iOS 16.4+; Android works in-browser too when installed.

## How sync works

```
client (whalechat.html) → GET /api/state (snapshot + rev)
                        → POST /api/ops   (diff ops: push/update/remove/set)
                        → GET /api/events (SSE: hello · change · reload)
                        → POST /api/push/* (VAPID subscribe + test)
server.js → data/state.json (atomic writes) → data/backups/ → web-push → FCM/APNs
```

Conflicts resolve last-write-wins per record. The client keeps a local copy, so it also works
offline and in local-only mode (mobile app when no server is configured).

## Security notes

This is a complete product prototype: auth, PINs and wallet balances are enforced client-side
against the shared database. Before handling real money, add server-side sessions/tokens,
validation and audit logging, and change the seeded admin password.


## What's new in 3.3.0

- **Save contacts by phone or username.** Contacts → *Add contact* now has a phone-number field and a
  username/email field plus a single **Save contact** button. Exact matches are saved instantly and the
  chat opens; partial matches show a picker. Saving adds the contact on both sides so either person can
  start the conversation.
- **Invite friends share sheet.** The **Invite friends** button on *My account* opens a sheet with the
  user's referral link, **Copy link**, native **Share…** and a link to referral stats.
- **Admin-editable app link.** Admin → Settings → *App link & invite links* sets the public link used in
  every invite and referral link (e.g. `https://chat.yourdomain.com/ref/CODE`), with a live preview and
  an editable invite message supporting `{link}`, `{code}` and `{name}`. Leave it empty to use the address
  that served the app.


## What's new in 3.4.0

- **Chat straight from search.** The search icon now opens the people search, and every result row has a
  **Chat** button (or **Save & chat** when you are not connected yet). Tapping it closes the search sheet,
  opens the conversation immediately and focuses the message box so typing can start right away.
- **Search fixes.** The header search button was wired to a missing handler — it now opens search. Search
  also matches phone numbers, and results include phone numbers so the right person is easy to pick.
- **Google Analytics (GA4).** Admin → Settings → *Google Analytics* accepts a `G-XXXXXXXXXX` measurement
  ID. The tag loads only when an ID is saved, and sends a `page_view` on every route change (no message
  contents). Leave it empty to disable. Find the ID in GA → Admin → Data streams → your web stream.


## What's new in 3.4.1

- **Google Tag Manager on every page.** `GTM-5WNCBL8N` is pasted immediately after `<head>` on the entry page
  and the app, with the standard `<noscript>` fallback after `<body>`. The app pushes `page_view` events to the
  container's `dataLayer` on every route change and deliberately does **not** add a second Google tag; any GA4
  measurement is configured inside Tag Manager.
- **Search → chat, guaranteed.** Chat rows in search results are fully tappable, the search sheet closes first,
  and the composer is focused (with retries) so the keyboard opens and the user can type immediately.


## What's new in 3.5.2 — branded links that redirect to the real app

Admin → Settings → **App link & invite links** now has two fields:

| Field | Example | Meaning |
|---|---|---|
| Custom app link (branded) | `https://whalechat.com` | The short link users see and share: `https://whalechat.com/ref/CODE` |
| Main app link (destination) | `https://your-app.example.com/whalechat.html` | Where every branded link sends the visitor |

How the redirect works:

- `/ref/CODE` on the branded host answers **302** to the destination with the code attached
  (`…/whalechat.html?ref=CODE`, or `…/ref/CODE` when the destination is a folder).
- `/` and `/whalechat.html` on the branded host also 302 to the destination, so the branded domain
  behaves as a pure redirector.
- If the branded domain hosts a static copy instead of this server, the app itself performs the same
  redirect on load (`maybeBrandedRedirect`), carrying any referral code.
- Leaving either field empty keeps the automatic behaviour (invite links use the server that served the app).

> For `https://whalechat.com` to work, point that domain at this deployment — a CNAME / Cloudflare Tunnel
> to the same server (recommended), or a static copy of `public/` at that host, which then redirects via JS.

The invite sheet labels branded links with “this branded link redirects to the live app” whenever the
branded host differs from the destination host.

## Live deployment

| Item | Value |
|---|---|
| Web app (HTTPS) | https://occupational-picked-seafood-powder.trycloudflare.com |
| PWA / install | open the URL → browser menu → Install app (iPhone: Share → Add to Home Screen) |
| Android release APK | `files/WhaleChat-3.5.2-release.apk` (signed, `app.whalechat.mobile` v3.5.2) |
| Health | `/api/health` → `{"ok":true,"app":"whalechat"}` |

> The URL above is a temporary Cloudflare quick tunnel bound to the build sandbox. For a permanent
> 24/7 host, deploy the same repo to Render / Docker / a VPS (below) and set `PUBLIC_URL` to your domain.

## Keep the site running 24/7 (cron + auto-heal)

`deploy/keepalive.sh` checks `/api/health` every run and restarts the app if it stops answering.
It can also restart a Cloudflare quick tunnel (`TUNNEL=1`).

```bash
# 1) systemd (recommended on a VPS)
sudo cp deploy/whalechat.service deploy/whalechat-keepalive.service deploy/whalechat-keepalive.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now whalechat whalechat-keepalive.timer

# 2) or plain cron (every 2 minutes + on reboot)
sudo cp deploy/crontab.txt /etc/cron.d/whalechat
sudo chmod 644 /etc/cron.d/whalechat
```

Both paths restart the process automatically; the database lives in `DATA_DIR` and hourly snapshots
keep the last 48 copies, so restarts never lose data.




## Demo sellers & demo media

The marketplace ships with a fleet of demo storefronts so it never looks empty. Six vendor
accounts publish **10–50 different electronics products each** (fridges, solar lamps, phones,
watches, sound systems, JBL players, chargers, headphones, speakers and power banks) from a
catalogue of 36 models — 144 listings in total.

Everything is generated from one source file and is safe to re-run:

```
catalog/demo-catalog.source.json      sellers, product models, specs, prices, image prompts
scripts/generate-demo-catalog.mjs     assigns 10–50 products per seller, sets price/stock, writes
                                      public/demo-catalog.json (sellers, all models, listings)
scripts/encode-demo-images.py         resize/crop renders → public/demo/{products,sellers,banners}/*.jpg.b64
assets-src/demo/{products,sellers,banners}/  source renders used when regenerating (needs Pillow)
public/demo-catalog.json              generated runtime catalogue fetched by the app
public/demo/products/*.jpg.b64        57 realistic product photos (36 core + 21 extra, 560×560)
public/demo/sellers/*.jpg.b64         6 real owner portraits (320×320)
public/demo/banners/*.jpg.b64         6 storefront banners (1200×400)
```

Regenerate after editing the source catalogue:

```bash
# renders already in assets-src/demo (products/<slug>.png, sellers/<slug>.png)
node scripts/generate-demo-catalog.mjs

# only rebuild the JSON, keep the committed photos
node scripts/generate-demo-catalog.mjs --skip-images

npm run build     # decode images + assemble public/whalechat.html
```

Bump `version` in `catalog/demo-catalog.source.json` when listings change — installed apps
re-seed automatically (updates in place, retires only demo listings that were never ordered).

### Storefronts

Every seller has a public profile at **`#/store/<vendorId>`**: banner, avatar, store name, owner,
location, member-since date, star rating and review count, trust score, product/order/stock stats,
tagline, bio, category filters, all of the store's live listings and a policies panel. Admin sees an
extra **Edit range** button there. Marketplace product cards and the product page's sold-by block
link straight to the storefront.

### Editing a seller's product range

**Admin → Demo sellers → Edit range** opens a per-store panel where an admin can:

- set how many products the store publishes (**10–50**, validated against the catalogue), and
- tick the categories its range is drawn from (only those models are used).

The override is stored in `DB.settings.demoSellers.ranges`, so it survives republishing and syncs to
every device. Saving updates the storefront in place: listings still inside the range keep their
price and stock, new ones are added, and listings that fall out of the range are hidden — unless a
real order references them, in which case they are retired (`active:false`) instead of deleted so
order history is never orphaned. **Reset to default** returns the store to its catalogue slice.

### Generating more products (append-only)

**Admin → Demo sellers → Generate more products** lets an admin pick a storefront (or all of them), a
category and **how many products to generate (1–50)**. Each run adds brand-new listings:

- unused catalogue models are assigned first, so new products never repeat a store's range;
- when a category's models are exhausted for a store, a distinct edition variant is created
  (e.g. *"FrostLine 610L French Door · Graphite"*) with its own price, stock and model slug;
- **nothing existing is removed, renamed or replaced** — the run only appends, and the toast reports
  how many listings were added;
- generated listings are flagged `generated: true`, so **Republish catalogues**, **Edit range** and
  **Reset range** all preserve them;
- every generated product gets a committed photo (`public/demo/products/*.jpg.b64`) — extra models can
  declare `deriveFrom` + `derive` in the source so the encoder creates a distinct shot from a base render.

### Company Marketplace product generator

**Admin → Products → Generate products** builds wholesale stock for the Company Marketplace that vendors
buy from. The admin enters **50–100** and each run appends that many *new* SKUs across electronics,
sound systems, phones, watches, bags, chargers, power banks and solar systems (plus laptops, tablets,
gaming, cases and accessories). Existing company products are never removed or overwritten — a second
run simply adds another batch.

- Pool: the 57 demo catalogue models + `public/company-catalog.json` (bags, solar systems and
  electronics wholesale lines) — 70 distinct models across 17 categories.
- Each run assigns a different model per category in rotation, then edition variants when a model is
  reused, so names and ids stay unique across batches.
- Wholesale prices are about 55–60% of retail, with stock of 30–180 units per SKU.
- Existing rows with no photo are back-filled with a matching category photo (no other field touched).
- Generated rows carry `generated: true` and a `batch` id; the card shows totals, category spread and
  the last run. Vendors see them immediately in **Vendor Hub → Company Market**.

Company-only assets live in `public/company/products/*.jpg.b64` and are decoded by the build, so every
generated product has a real photo.

### Bulk demo users & per-user orders

**Admin → Demo shoppers → Generate demo users** creates between **1 and 10,000** demo shopper accounts
with realistic names, cities and rotating portrait photos. Records are compact (~210 bytes each) so a
10,000-user fleet takes about 2 MB; run another batch any time and it continues the numbering without
duplicating ids or usernames.

**Demo orders** on the same page lets the admin choose **how many demo users place an order**. Each
selected user gets one simulated order from a demo storefront, dated within the previous three weeks,
with mixed statuses and a full delivery record (derived on the fly for bulk users). Orders appear in
order history, the demo activity dashboard and the storefront leaderboard.

Both generators check the projected state size before saving: if a run would exceed this device's
storage budget it rolls back completely and tells the admin to try a smaller number — nothing is
partially written. Scheduled shoppers (the 8 named personas) keep their weekly cadence; bulk users
only order when the admin asks them to.

### Company support & vendor refunds

- **No vendor↔shopper chat.** Direct conversations between a store account and a shopper are blocked in
  both directions, including existing conversations and hash links. Any attempt redirects to company
  support; vendors can still talk to admin, and shoppers keep normal chats with each other.
- **Live support everywhere.** The order sheet's circled vendor action is now **Support** and opens the
  company live chat (Tawk widget) with the order reference attached. If the widget is slow to load it
  falls back to the in-app support conversation with the admin — never to the vendor.
- **Stock refunds for vendors.** The vendor hub has **Stock returns & refunds → Request refund**. The
  modal lists every eligible company purchase with its unsold quantity, lets the vendor tick several
  products, and requires a reason. Submitting creates one pending refund request; admin reviews it in
  **Admin → Refunds**.
- **Approval is atomic.** Every line is re-checked for remaining stock; then the units are removed from
  the vendor's inventory (the listing disappears when the last unit goes), added back to the Company
  Marketplace stock, the purchases are marked refunded, and the exact amount paid is credited to the
  vendor's Whale Coin balance with a transaction record and notifications. Rejection leaves everything
  untouched and sends the reason to the vendor.

### Sales performance reports

**Admin → Sales** (`#/admin/sales`) tracks sales across the whole app, every seller and every product.

- **Totals:** revenue, units sold, paid orders, average order value, stock remaining, storefront views and
  view-to-sale conversion, with a 14/30-day revenue chart (units shown above each bar).
- **Per seller:** orders, units, revenue, remaining stock, storefront views and conversion, with a revenue
  share bar and a link to the shop.
- **Per product:** units, revenue, remaining stock, product-page views, conversion and revenue share,
  ranked by revenue (top 60).
- **Sales records:** the newest 150 orders with buyer, seller, items, units, total, status and demo flag;
  exportable to CSV.
- **Filters:** last 7 / 14 / 30 / 90 days and **All orders / Real sales only / Demo only**, so simulated
  demo activity is never mixed into real revenue.

Views are counted once per session per day for signed-in shoppers (admins and bots excluded), on both
storefront pages (`vendor.storeViews`) and product pages (`product.views`). Daily totals are kept in the
synced `traffic` collection (60-day retention), which feeds the chart and the activity dashboard.

### Demo activity dashboard

**Admin → Demo activity** (`#/admin/demo-activity`) is the demo fleet's analytics page: seller /
shopper / listing / order counters, simulated GMV, a 14-day orders chart, storefront leaderboard,
category mix, per-shopper spend and cadence, and the most recent demo orders. Everything is computed
from orders flagged `simulated`. The first time the storefronts seed, 72 historical demo orders are
backfilled across the previous 28 days (deterministic IDs, so devices never duplicate them), and
**Generate orders** adds another 24 dated within the last three days.

In the app, **Admin → Demo sellers** shows every storefront with its product count, and lets an
admin turn the fleet off (hides the listings) or republish the catalogues. Each seller account is
`isBot` + `isDemoSeller` with no password, and every listing carries `demo: true`, so demo stock
is always distinguishable from real vendor inventory. Demo shopper orders remain flagged
`simulated` as before.

Product photos and portraits are studio-style renders shipped with the app — no emoji and no
placeholder graphics. Owner avatars live at `./demo/sellers/<seller-slug>.jpg`.
