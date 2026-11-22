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
