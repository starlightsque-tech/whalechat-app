# Instant + offline chat, live Binance, and 1:1 messaging

Release **3.46.0**. This document explains exactly what changed, how to deploy it, and
how to switch the chat transport to Appwrite if you want it.

---

## 1. What the user experiences

| Action | Before | Now |
|---|---|---|
| Tap Send | 3–5 s, blocked on the server | **message on screen in ~6 ms**, input cleared, network in the background |
| Receive a message | up to 5 s (poll + full state download) | **~120–170 ms** over one realtime connection |
| Offline | message fails / disappears | message stays with a **clock icon**, survives reload, **auto-sends on reconnect** (no button) |
| Open a chat | spinner / blank while fetching | **cache-first** from IndexedDB, then quiet background refresh |
| Ticks | single / double only | **clock** = queued · **✓** = sent · **✓✓** = delivered · **blue ✓✓** = read |
| Add a contact | both sides had to save each other | A can message B by username; **B instantly gets the thread** even without saving A |

Measured on the automated end-to-end test in this repo (headless Chrome, two separate
browsers, real server):

```
message painted in <50ms ......... PASS   5.6 ms
input cleared immediately ........ PASS
B sees A message in <500ms ....... PASS   125 ms
A receives read receipt .......... PASS
offline message stays in outbox .. PASS
offline message shows clock ...... PASS
queued message survives reload ... PASS
auto-syncs on reconnect .......... PASS
```

---

## 2. Architecture

```
 tap Send
    │
    ├─ (1) message object { tempId, status:'queued', createdAt:now }
    ├─ (2) written to IndexedDB + drawn on screen immediately  ← no await, no fetch
    ├─ (3) appended to the IndexedDB `outbox`
    └─ (4) input cleared

 outbox flush (page + service worker)
    ├─ POST /api/messages/send        (device-generated id = idempotent retry)
    ├─ success → status 'sent', row removed
    └─ offline / failure → retry 5 s → 10 s → 30 s → 60 s, clock icon

 realtime (ONE EventSource for the app's lifetime)
    ├─ event: message   → write to IndexedDB → draw if open, else unread badge
    ├─ event: delivered → ✓✓
    └─ event: read      → blue ✓✓

 history
    ├─ boot: IndexedDB cache merged into the in-memory DB  (instant open)
    └─ chat open: GET /api/messages/list?since=…  → merge silently
```

There is **no polling**, and chat traffic no longer triggers a full `/api/state`
download: the server marks message-only revisions with `messagesOnly:true` and the
client skips the state sync for them. That full download was the 3–5 s.

### Files

| File | Role |
|---|---|
| `public/chat-instant.js` | optimistic send, IndexedDB store, outbox, realtime ingest, read receipts, ticks, contact-less threads, cache-first history |
| `public/binance-live.js` | top-100 Binance universe + WebSocket feed, auto-reconnect, status pill, feeds `WC_MARKET.applyQuotes` |
| `public/market-live.js` | now exposes `MK.applyQuotes` so any feed can drive every price label |
| `server.js` | `/api/messages/send`, `/api/messages/list`, `/api/messages/ack`; SSE fan-out to exactly the two participants; `messagesOnly` revision flag |
| `public/sw.js` | background outbox flush (`sync` / `periodicsync`), new cache version |
| `scripts/prepare-assets.js` | injects the two new modules into the bundle |

### Server API

```http
POST /api/messages/send
{ "message": { "id":"msg_...", "chatId":"usr_a__usr_b", "from":"usr_a", "to":"usr_b",
               "type":"text", "text":"hi", "createdAt": 1730000000000 } }
→ { ok:true, id, rev, status:"sent", online:[…] }
   409/duplicate-safe: sending the same id twice returns { ok:true, duplicate:true }

GET  /api/messages/list?chatId=…&user=…&limit=200&since=<ms>
POST /api/messages/ack    { chatId, userId, ids:[…], kind:"read"|"delivered" }

GET  /api/events?client=…&user=<userId>
   event: message · delivered · read · change { rev, messagesOnly }
```

Privacy: `message`/`read`/`delivered` frames are only written to sockets registered
with the sender's or recipient's user id. The automated test asserts that a third
user receives nothing.

---

## 3. Deploy

### 3.1 Backend (required for the <500 ms receive path)

The static app can talk to the existing WhaleChat server — **Fly, VPS or Cloudflare
Tunnel, not Render**. Deploy the new `server.js`:

```bash
fly deploy            # or: systemctl restart whalechat / docker compose up -d
curl -s https://<your-server>/api/health
```

If the backend is not redeployed, the client degrades gracefully: sending is still
instant and offline, but the message goes through the legacy state sync (no
message-level realtime, so the recipient may wait for a state refresh).

### 3.2 Static app

```bash
npm run build          # assembles public/whalechat.html + injects both modules
wrangler pages deploy public --project-name whalechat
```

Deploy these files: `whalechat.html`, `index.html`, `manifest.webmanifest`, `sw.js`,
`release.json`, `assets/`, **`chat-instant.js`**, **`binance-live.js`**.

The bundle has a fallback loader for the two modules, so a plain copy of `public/`
also works without the build step.

The static build no longer hardcodes the Render host. It uses
`DEFAULT_SYNC_SERVER` (`https://whalechat-live.fly.dev`). A self-hosted server still
injects its own origin automatically.

---

## 4. Appwrite (optional transport)

**The project id in the brief — `6afec9ae002d0af5e0c6` — does not exist.**
`https://cloud.appwrite.io/v1/account` with that `X-Appwrite-Project` header returns
`404 project_not_found`, so nothing can be written to it. Create a project first:

1. Appwrite console → **Create project** → copy the project id.
2. **Databases → Create database** `whalechat_db`.
3. **Create collection** `messages` with attributes:

   | Attribute | Type | Required |
   |---|---|---|
   | `messageId` | string (64) | yes |
   | `chatId` | string (256) | yes |
   | `from` | string (64) | yes |
   | `to` | string (64) | yes |
   | `type` | string (32) | yes |
   | `text` | string (4096) | no |
   | `createdAt` | integer | yes |
   | `status` | string (16) | yes |
   | `deleted` | boolean | no |
   | `readBy` | string[] | no |

4. **Indexes** (this is the part that keeps it fast as the collection grows):

   | Key | Type | Attributes |
   |---|---|---|
   | `idx_chat_created` | key | `chatId` ASC, `createdAt` DESC |
   | `idx_sender_created` | key | `from` ASC, `createdAt` DESC |
   | `idx_message_id` | unique | `messageId` |

5. **Permissions**: document security on, with read/update for the two participant
   users (`user:<userId>`). Realtime only delivers documents the session can read.
6. Enable the **messages** collection for Realtime in *Database → Settings*.

Then point the app at it (no code change, no rebuild):

```js
localStorage.setItem('wc.appwrite', JSON.stringify({
  endpoint: 'https://cloud.appwrite.io/v1',
  project:  '<your-project-id>',
  database: 'whalechat_db',
  collection: 'messages'
}));
location.reload();
```

`chat-instant.js` then writes documents with `POST /databases/…/collections/messages/documents`
and receives them through `client.subscribe('databases.whalechat_db.collections.messages.documents')`
(one subscription for the app lifetime). The optimistic UI, outbox, retries, ticks and
cache-first history are identical — only the transport changes. Remove the
`wc.appwrite` key to go back to the WhaleChat server.

> Keep `server.js` in the deployment even with Appwrite enabled: accounts, wallet,
> marketplace and admin data still live there.

---

## 5. Binance live crypto

* Universe: **top 100 USDT spot pairs by real 24 h quote volume**, refreshed every
  30 minutes (`data-api.binance.vision` first, then `api.binance.com`, `api1`).
* Stream: one combined WebSocket — `…/stream?streams=btcusdt@miniTicker/…` —
  `data-stream.binance.vision` first (reachable where the main host is geoblocked),
  then `stream.binance.com`.
* Quotes are painted at most every 220 ms through the existing
  `WC_MARKET.applyQuotes` pipeline, so **price labels, percentage change, charts,
  watchlist, holdings and portfolio values all move together**.
* Resilience: exponential reconnect, host rotation, 45 s silent-socket watchdog,
  re-connect on `online`, on tab wake, and every 30 min when the ranking refreshes.
  Binance's own 24 h connection rotation is handled by the same reconnect path.
* The coins are **virtual catalogue entries** (`INV.stock` / `INV.stocks` are
  extended in memory) so they never get pushed through the cross-device state sync —
  no ping-pong, no storage churn, but they render and chart exactly like saved stocks.
* A pill on market / invest / stock / trade / portfolio pages shows
  `LIVE · 100 coins · Binance` with the connection state.

Verified in this repo's browser test: `status:live`, `symbols:100`, `crypto:103`,
BTC `$60,287.14` with `changePct:-2.21`, ticks rising across two samples.

---

## 6. Operational notes

* IndexedDB database `whalechat_instant` (stores `messages`, `outbox`, `meta`) survives
  reloads and app restarts; the service worker can drain the outbox while the tab is
  closed (Chrome/Android `background sync`; iOS relies on the page flush on resume).
* The outbox retries at 5 s → 10 s → 30 s → 60 s and stops retrying on a 4xx that is
  not rate limiting (permissions/schema), keeping the text in the queue for inspection.
* Message ids are generated on the device and reused as the document id — retries and
  duplicate background flushes can never create a duplicate message.
* Ticks and receipts: the recipient sends `delivered` when a message lands and `read`
  when the thread is open; both are pushed only to the sender.
