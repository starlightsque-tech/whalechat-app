# WhaleChat 3.5.2 — web app + mobile apps

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
