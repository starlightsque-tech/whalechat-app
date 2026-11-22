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
