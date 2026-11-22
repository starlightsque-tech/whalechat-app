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
