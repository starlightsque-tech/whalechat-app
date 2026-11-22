# WhaleChat 3.62.0

Finishing pass on the account dashboard card and the WC-Investing plan view.

## Chat + WC-Investing buttons on the main account dashboard card
- The **ACCOUNT BALANCE** card on *My account* now has a full-width two-button row
  directly underneath the six action buttons (Deposit · Investment account ·
  Withdraw · Invite friends · Convert · Transfer), exactly where the reference
  screenshot circled it.
- **Chat** opens the chat page (`#/home`); **WC-Investing** opens the
  WC-Investing account page (`#/invest/shares`).
- Teal for Chat, blue for WC-Investing, with the icon and label; the row also
  stays on the WhaleChat Shares dashboard card and the WC-Investing summary.

## Active plan chart now uses the live trading chart
- The mini chart inside each **Active WhaleChat investments** plan card is drawn
  by the same live chart component the stock trading view uses
  (`WC_LIVE_CHART`, green when the price rises, red when it falls, gradient fill,
  right-hand USD scale, time labels) instead of the old static sparkline.
- The **Plan performance · ROI progress** card keeps the same engine, so every
  WC-Investing chart now looks and moves like a trading chart.

## Live earnings counter
- Each active plan card shows a **Live earnings** strip that counts up every
  second — USD earned, updated in place from the WC-Investing engine (no page
  reload), alongside the existing WC earnings cell and current value.
- The hero "Total earnings from WhaleChat shares" figure ticks live as well.

## Real-time Whalecoin movement counter
- The WhaleChat share-price card now has a **Live movement** counter:
  current Whalecoin price, a green/red `▲ +0.83%` badge and the window the move
  covers ("last 1.0h"), refreshed every second and pulsing while live.
- Each active plan card repeats the current Whalecoin price and its movement
  against the plan's entry price.

## Payouts calculated from the share-price movements
- A local Whalecoin market walk keeps `DB.shareMarket` (current price + history)
  moving the same way the sync server's shares worker does, so the share-price
  card, the plan charts and the payout all read one series.
- A plan's profit is driven by the prices it actually saw:
  `daily profit = capital × plan rate × that day's Whalecoin price`, summed over
  the recorded days, so a rising market pays more and a falling market pays less
  (and the crash level still applies at maturity).
- The plan value curve the chart draws is rebuilt from that movement history, so
  the line follows the market instead of a fixed projection.

## Profit history log on every active plan
- Each active plan card now carries a **Profit history · daily closes** table:
  day number and date, that day's Whalecoin price with its move from the entry
  price, what the day earned in USD, and the running total at the close.
- A highlighted **Today (running)** row shows the live price, today's earnings
  so far and the running total, updated every second.
- The log is produced by `WC_INVEST.profitLog(plan)` and persisted on the plan
  (`plan.profitLog`) at each market tick and sweep, so it survives a reload and
  always matches the payout maths exactly.

## Live earnings graph + Whalecoin ticker on the dashboard card
- The hero card at the top of WhaleChat Shares (WC-Investing dashboard) now has
  a **Whalecoin ticker** — live price, green/red `▲ +1.44%` badge and the window
  the move covers — refreshed every second.
- Under it sits a **live earnings graph** in the same trading-chart style as the
  stock view: principal + accrued profit, green/red segmented line, soft fill,
  right-hand WC scale, an INVESTED dashed line and a live percentage badge.
- The Plan performance chart now reads the same engine values, so the chart
  value, ROI, earnings and the plan cards can never disagree.

## Payment slip photos on deposits (3.62.2)
- The deposit page has a new **Payment slip** field with two buttons:
  **Take photo** (`capture="environment"`, opens the phone camera) and
  **Gallery** (`accept="image/*"`, opens the photo picker).
- Up to **3 photos**: each is compressed to 1000 px JPEG, shown as a thumbnail
  with a remove button, and can be tapped to view full size or saved.
- On submit the deposit record stores `proof` (first slip) and `proofs` (all of
  them); the confirmation screen states how many were attached.
- Admin → Deposit requests has a **Slip** column with thumbnails and a full-size
  viewer, so a reviewer can check the receipt before approving.

## Deposit approval always credits the crypto balance (3.62.3)
- `App.depApprove` no longer writes the balance inline. It calls
  `applyDepositCredit(user, deposit)`, which:
  - normalises the coin (`USDT`, `BTC`, …, bank → `USD`) and the amount,
  - repairs a `depositBalances` field that is not a plain object,
  - writes the credit **and** an `acctLedger` entry with `meta.depositId`,
  - marks `creditedToDeposit / creditedCoin / creditedUsd / creditedAt`,
  - refuses to credit twice — the ledger entry is the proof of the credit.
- `reconcileDepositCredits(user)` re-applies any approved deposit that has no
  ledger entry, so an approval made on another device, a lost sync or an older
  build heals automatically: it runs on every account view and every 12 s on
  every device, then syncs and notifies the user "Deposit credited ✅".
- The admin deposit queue shows **✓ credited · COIN $amount** or
  **not in the balance**, with a one-tap **Credit** button to re-apply an
  approved deposit that is missing its credit.
- Approving an already-credited deposit is a no-op (no double credit), and the
  approve toast now reports the new coin balance.

## Permanent sign-in until Sign out (3.62.4)
- A session no longer expires and nothing signs the user out on its own:
  `SESSION` lives in `localStorage` with no TTL and is kept through reloads,
  updates, offline starts and sync races.
- **Account backup.** The signed-in account record is snapshotted on the device
  (`wc.session.user.v1`, refreshed every 30 s, on tab hide and on unload). If a
  sync leaves the server copy of the user missing, `restoreSessionUser()`
  re-adds it locally and pushes it back — the user is never dropped to the login
  screen.
- **No silent logouts.** The two server-state checks in `Remote.refresh()` and
  the boot check no longer clear the session; they restore the account instead.
- **Sign out is the only way out.** `App.logout` clears the localStorage
  session, the account backup and the sessionStorage session copy, and sets a
  `wc.signedout` marker that stops `session-guard` from resurrecting the old
  session; signing in (or signing up) clears that marker. The "Switch account"
  button does the same.
- A guard in `session-persist.js` also blocks a stray
  `localStorage.removeItem('whalechat.session.v1')` from an older code path
  while the user is signed in.

## Live chat opens the installed Tawk.to widget (3.62.5)
- **Root cause:** `no-chat-widget.js` deleted the Tawk iframes, its containers
  and its script every 2.5 s to hide the floating bubble, and the "open" code
  only checked that `Tawk_API.maximize` existed. The API object outlived the
  widget, so the button "worked" and opened nothing.
- `no-chat-widget.js` now only styles the widget: the bubble is hidden, the chat
  window is hidden until `body.wc-livechat-open`, and nothing is removed.
- `live-chat-open.js` owns the widget: it verifies the chat iframe actually
  exists, reloads the embed from scratch when it does not, retries for ~24 s and
  opens it full screen (`showWidget()` + `maximize()`) above the bottom nav.
- `App.liveSupport()` (order support, service-centre "Live chat support") now
  delegates to the same opener, so every live-chat button hits one code path.
- `tawk-control.js` no longer auto-loads or shows the floating bubble when live
  chat is enabled — the widget is only loaded/opened by a button tap.

## Live chat button really opens the chat box (3.62.6 / 3.62.7)
- **Root causes**
  1. `no-chat-widget.js` deleted every Tawk iframe, container and script every
     2.5 s (to hide the floating bubble), so the widget was gone while
     `Tawk_API.maximize` stayed defined — the button "opened" a dead widget.
  2. The embed script was requested with `crossorigin="*"`; when a network or
     proxy refuses that CORS request the script never runs (a console CORS
     error) and nothing appears.
  3. Only `App.openLiveChat` used retries; the order-support and service-centre
     buttons called `App.liveSupport()`, which silently "succeeded".
- **Fixes**
  - `no-chat-widget.js` now only styles the widget (bubble hidden, chat window
    hidden until `body.wc-livechat-open`). Nothing is removed any more.
  - `live-chat-open.js` is the single owner: it checks the chat iframe really
    exists, loads the embed with the official attribute and retries as a plain
    script if that is blocked, re-creates the widget when the iframe is missing,
    and retries for ~24 s.
  - If the embed still cannot start within ~6 s, the app opens **Tawk's hosted
    live chat page in a full-screen in-app frame** (with Close and an in-app
    Support shortcut), so the chat box always appears.
  - `App.liveSupport()` delegates to the same opener, so every Live chat /
    Live support / "Live chat support" button behaves identically, and the tap
    shows "Opening live chat…" immediately.
  - `tawk-control.js` no longer auto-loads or shows the floating bubble when
    live chat is enabled.

## No more auto-refresh under the user (3.62.8)
- **New `ui-no-refresh.js` (`WC_QUIET`).** Tracks pointer/wheel/scroll/key/input
  activity and provides `WC_QUIET.busy()` and `WC_QUIET.render()` (a background
  render that waits for an idle moment). Every render now saves and restores the
  scroll position and the focused field/selection (only when the route did not
  change), so a sync can never throw the user to the top of a page or out of the
  form they were filling in.
- **Shares / WC-Investing page no longer rebuilt on a timer.** The 2.5 s poll now
  runs every 9 s, is skipped while the user is busy, and only rebuilds the page
  when the set of plans/investments actually changes. Everything else — total
  earnings, invested, accrued, active plans, each plan's earnings and current
  value, the Whalecoin ticker, the live charts — is updated in place every
  second. The hero graph is only redrawn when its line really changed.
- **WC-Investing live repaints** (`wc-invest-ui`, `wc-invest-plans`) no longer
  call a full `render()` on their 5 s/30 s timers on those pages; they use the
  quiet renderer, which defers while the user is scrolling, typing or a dialog
  is open.
- Verified: on the Shares page the app performs **0 full renders in 15 s idle**,
  the scroll position stays exactly where the user left it, renders are deferred
  to 0 while the user scrolls, and a deposit form keeps its value and focus
  across background ticks while the live numbers keep moving.
