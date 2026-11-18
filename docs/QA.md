# QA: route audit and feature coverage

"Everything works" is only a useful statement if it is measured. This page
records what is actually exercised, how to re-run it, and what remains outside
the harness's reach.

## Run it

```bash
npm run build            # assemble whalechat.html
npm run audit:routes     # user + admin, online + offline
npm run test:offline     # static: manifest, SW, IndexedDB schema, installability
npm i -D jsdom fake-indexeddb
npm run test:offline:runtime   # offline chat/cart/outbox/flush/pay guard (32 checks)
npm run test:ui                # Toyota ticket, leverage, B2B history (19 checks)
```

`audit:routes` boots the **assembled bundle** in jsdom, seeds a realistic
database (admin + users + vendor + products + orders + messages + stocks incl.
Toyota + open trade + B2B fills/alerts), signs in, renders every route and fails
on: a thrown exception, a `console.error`, an unhandled rejection, a
"Page not found" render, an empty render, or a render slower than 4 s.

Coverage: **52 user routes + 37 admin pages**, each in two network states
(`navigator.onLine` true with a JSON fetch stub, and false with every fetch
rejecting) — 178 renders per run.

## Latest result

| Session | Network | Routes | Result | Slowest render |
| --- | --- | --- | --- | --- |
| user | online | 52 | all clean | 199 ms (`chat/u_admin`) |
| user | offline | 52 | all clean | 197 ms (`chat/u_admin`) |
| admin | online | 37 | all clean | 200 ms (`admin/stocks`) |
| admin | offline | 37 | all clean | 218 ms (`admin/stocks`) |

## Bugs this audit found and fixed

1. **Marketplace crash on a vendor without a rating.** `productCard` called
   `v.rating.toFixed(1)`; a vendor row created before those fields existed (or
   imported) broke the market, product and store pages plus the admin vendor
   list. Added `vendorRating()` / `vendorTrust()` helpers with sane defaults.
2. **Admin dashboard crash on partial bot state.** `adminBodyHTML` guarded `a`
   but then read `a.stats.subscriptions`; a partial/offline state threw. Now
   defaults `stats` and `tiers`.
3. **Admin → Connections rendered in an infinite loop while offline.** The view
   called `load()`, which failed, then called `render()`, which called `load()`
   again — the tab grew until the process ran out of memory. It now loads once at
   a time, re-renders only when data actually arrives, and backs off 15 s.
4. **Unhandled promise rejections offline** in the market data poller and the
   shares admin panel: both now end their chains with a `.catch`, so a failed
   poll leaves the last data on screen instead of logging an error.

## What the harness does not prove

* jsdom is not a real browser: layout, CSS, `EventSource`/WebSocket streaming,
  service-worker lifecycle and push delivery are not exercised here.
* The server is not running in these tests, so "online" means a stubbed JSON
  response. Real network behaviour is covered by the offline tests (which assert
  the fallback path) and by `/api/health` checks against the deployed instance.
* Admin actions that require a live admin session (saving provider keys, sending
  broadcasts) are rendered but not executed.
* Anything depending on a real payment provider, a real blockchain transfer or a
  third-party outage is outside what any test here can promise.

For a device check: open the deployed URL, install it, load every tab once
online, then repeat with airplane mode on. Offline the app is expected to render
the same routes from cache — the audit above is the automated equivalent.
