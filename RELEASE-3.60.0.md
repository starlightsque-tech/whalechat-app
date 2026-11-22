# WhaleChat 3.60.0

Built from the latest public build (3.59.0 main + the live 3.60.0 media fix)
and completed for this release.

## Brevo email server
- `BREVO_API_KEY` (transactional API) is the primary transport.
- `BREVO_SMTP_USER` + `BREVO_SMTP_KEY` connect the Brevo SMTP relay
  (`smtp-relay.brevo.com:587`) when an API key is not used.
- Admin → Servers can store the Brevo key, Brevo SMTP login/key and the
  verified sender; status now reports the active provider.
- Signup codes, welcome mail and notifications all go through the same sender.

## Verification codes that never reject a correct code
- Codes are normalised: leading zeros, spaces, dashes, non-breaking spaces,
  full-width digits and pasted text are accepted.
- Every code issued in the last 24 hours stays valid; a resend never
  invalidates the code already in the inbox.
- Wrong guesses are counted, but expiry and attempt counters can never reject
  a code the server actually emailed. A matching code always verifies.
- Verification is idempotent: repeating it, or re-entering the code after the
  account is verified, returns success instead of an error.
- Network or sync-write hiccups no longer look like a wrong code — the device
  verifies locally and the next sync carries `verified: true`.
- Both the sync server (`/api/verify/signup/*`) and the Cloudflare Pages edge
  (`/api/otp/send`, `/api/otp/check`) implement the same rules.

## Restored accounts
`npm run restore:users` (or `node scripts/restore-users-360.mjs`) restores
`jane` and `investorD` from the newest 3.56.0 snapshot/backup into the 3.60.0
state, keeping their original id and password hash, and heals verification.
Run it against the server's `DATA_DIR` (and `DATABASE_URL` when Postgres is
used). Live accounts `jane` and `investorD` were recreated and verified on the
Cloudflare sync host because no 3.56.0 snapshot still contained them.

## Cloudflare database (D1)
Every account and all app data is mirrored from the Durable Object into the
Cloudflare D1 database `whalechat_db` (`env.DB`) and restored from it when the
object storage is empty, so publishing never wipes users.
- Binding: `wrangler.toml` → `[[d1_databases]] binding = "DB"`.
- Tables: `app_state_chunks`, `users`, `messages`, `files`, `sessions`
  (`cloudflare/whalechat-api/schema.sql`, apply with `npm run db:init`).
- Only the active Durable Object may write to D1; leftover older instances are
  locked out so they cannot overwrite fresh data after a publish.
- `npm run db:check` verifies the binding, tables, snapshot rev, and the
  restored `jane` / `investorD` accounts.

## Session rooms removed
The Share Internet Session / room-code feature is removed from the app.
- `session-bridge.js` is no longer bundled (no Share session button, no
  sessions modal, no #/session deep link, no room chat overlay).
- The worker answers every `/api/rooms/*` request with a clean 404, so cached
  clients and old links cannot open a room.
- Existing user accounts, direct chats and data are untouched.

## WC-Investing admin editing
Admin → **WC-Investing** lets an administrator:
- edit each plan's name, daily rate, duration, minimum, maximum and description;
- add, delete or reset plans to the defaults;
- set the WhaleChat share price and the crash level;
- adjust a running user plan's rate/duration (end date and projected ROI are
  recalculated, capital is untouched).

Plans save to `DB.settings.investPlans` and sync, so every device gets the new
catalogue. The WC-Investing dashboard shows an "Admin · edit plans" shortcut to
admins only.

## Auto take-profit and trade moves
- **Moves N** now counts every distinct price move in the user's trade
  direction (Move 1, Move 2 …), for the whole life of the trade. Moves against
  the trade are not counted and the counter is never reset by a take/re-base.
- **Auto Secure** evaluates every favourable move (200 ms engine tick, 500 ms
  monitor) and secures profit the moment the available amount reaches the
  user's TP level. Amounts below the TP are left running, so nothing under the
  user's level is taken and nothing at/above it is skipped.
- Secured profit is **not silently credited**: each lock is stored as an
  unclaimed entry the user claims with **Take profit** / **Claim all**, so a
  user who was offline can claim everything on return.
- The server engine (`market.js`) does the same for subscribed users while the
  app is closed, and mirrors the directional move count.

## Offline Auto Secure alerts, move tape and instant trade buttons
- Auto Secure marks locks created while the device is offline and raises both
  an in-app notification and a floating "locked while you were offline" alert
  with a **Claim all** button. Server locks are marked offline too, so locks
  created while the app was closed surface when the user returns.
- Every active trade shows a visible **Trade moves** tape: Move 1, Move 2 …
  with the price at each move and the amount Auto Secure locked there (or
  "below TP" when the move did not reach the user's level).
- **Stop trade** and **Take loss** now settle the trade in the same click — no
  network round trip is allowed to delay the button. Take profit and secured
  profit claims are local-first and sync afterwards.
- Take loss set on a trade is enforced by the always-on engine: the trade is
  closed automatically at the loss limit to protect the remaining capital.

## Loud notification alerts + welcome artwork
- New `notify-alert.js` plays a **loud three-tone chime** (Web Audio, unlocked
  on the first tap) and a strong vibration pattern for every notification and
  every new incoming chat message. Push notifications use the same loud
  vibration pattern and are marked non-silent.
- The supplied photo is now part of the welcome page hero, blended behind the
  WhaleChat card with a radial mask on desktop and a soft banner above the card
  on mobile, matching the app's teal/dark design.

## Live support opens the installed chat box on tap
- The live-chat widget is preloaded quietly after sign-in (bubble hidden), so
  tapping **Live support** opens the chat box immediately instead of waiting
  for the third-party script.
- The tap now calls `showWidget()` + `maximize()`; the earlier minimize hook
  that hid the widget again was removed.
- If live chat is switched off in Admin, the button falls back to the in-app
  support dialog instead of doing nothing.

## WC-Investing capital top-up fixed
The WC-Investing transfer page had no path from the investment account, so a
top-up could not be completed. Added:
- **Investment account → capital balance** (`invest2capital`) and the reverse
  **capital balance → investment account** (`capital2invest`).
- The transfer form lists the investment balance and defaults the top-up
  option first; the dashboard also has a **Top up capital** shortcut.
- Transfers debit/credit `investAcct.usd` and `investAcct.portfolios.wc`
  (the same field the WC-Investing capital balance reads) and sync both.

## WC-Investing capital now shows on the Shares page
The cloud sync host does not run the shares engine (`/api/shares/state`
returns `enabled:false`), so the WhaleChat Shares page was showing 0 WC and a
$0.00 share price regardless of the real capital. It now falls back to the
local WC-Investing engine:
- capital badge reads **investAcct.portfolios.wc** — the same field a transfer
  credits — and is shown as **USD capital**;
- plans come from the WC-Investing catalogue and investing uses the local
  `WC_INVEST.activate` engine when the server has no shares engine;
- the page rebuilds its state on every visit, so a top-up is visible
  immediately after the transfer.

## WC-Investing transfer confirmation, unified Shares data, crypto funding
- The WC-Investing transfer now opens a **confirmation screen** showing the
  investment trade balance **before → after**, the WC-Investing capital balance
  **before → after**, and the new capital balance after confirming.
- The WhaleChat Shares page now reads the **same WC-Investing engine** as the
  WC-Investing page — capital, active plans and share price always agree.
- Plans can be activated from the WC-Investing page and can be paid from the
  **WC-Investing capital balance or any crypto balance** (crypto is spent at
  its USD value). The crypto balance is debited only once and the plan keeps
  its own capital/profit terms.
- Investment trade balance → WC-Investing capital remains available with the
  new confirmation step.

## Funding source on plans + live transfer verification
- Each active plan card (WC-Investing and WhaleChat Shares) now shows a badge:
  **Funded from WC-Investing capital** or **Funded from crypto · <COIN>**.
- WC-Investing history entries now record the funding source
  (`funded from WC-Investing capital` / `crypto USDT`).
- Live account reconciliation: the earlier $200 investment → capital transfer
  is now recorded in the investment ledger and WC-Investing history; the
  balances (investment $1042.05 → capital $1500) already matched it.
- A $1 verification transfer was run end to end on the live account:
  **investment $1042.05 → $1041.05, capital $1500 → $1501**, both recorded.

## Account quick buttons + reference-style WC-Investing charts
- The WhaleChat account dashboard card now has two quick buttons:
  **Chat** → chat page, **WC-Investing** → WC-Investing account page.
- WC-Investing active-plan charts, the dashboard ROI progress chart and the
  ROI page chart now use the reference market-chart style: dark panel,
  red/green line with soft fill, right-hand USD scale, the current value in a
  coloured badge, dashed grid and time labels along the bottom.
