# WhaleChat 3.63.0 — smooth chat, stickers, status control, Servers & API

## 1. Chat never interrupts typing again (the "shaking / blinking" report)

Users reported: *"the app kept shaking as if it's tripping on and off quickly
and it kept on interrupting my typing… the app is slow due to this issue."*

**Cause.** The app rebuilt the entire screen (`app.innerHTML = shellHTML(...)`)
for every background change. On the chat screen that constant rebuild:

* destroyed the `<textarea>` the user was typing in (text kept, caret lost);
* re-focused it in `AFTER.chat`, so the phone keyboard flashed open/closed —
  the visible "shaking";
* scrolled the thread to the bottom on every pass;
* re-parsed the whole app (≈2.4 MB) each time — the "slow" feeling.

Every one of these ran while the user was typing:

| trigger | old behaviour | period |
|---|---|---|
| typing notice from the other side | full re-render | every keystroke |
| delivery tick (`sent → delivered`) | full re-render | every 4 s |
| presence heartbeat | full re-render | every 25 s |
| incoming message (BroadcastChannel) | full re-render | per message |
| cross-device sync / storage event | full re-render | per change |
| send + delivery ack | two full re-renders | per message |

**Fix — `public/chat-smooth.js` (new):**

* `render()` now calls `WC_SMOOTH.intercept()` first. While a chat screen is
  open **and the composer is active**, the rebuild is cancelled and only the
  difference is painted: new bubbles are appended, ✓✓ ticks and the
  "typing…"/"online" header are updated in place. The composer node, its text,
  its caret and the keyboard are never touched.
* Navigation is never delayed: a route change always renders normally, and a
  deferred rebuild is flushed the moment the composer loses focus or the tab
  changes.
* `AFTER.chat` takes the keyboard **once per chat** instead of on every render.
* The four background paths above now call `paintTicks()`, `paintPresence()` and
  `syncChat()` instead of `render()`; the send path uses `afterSend()` so the
  composer keeps focus and the keyboard stays open.

`scripts/test-chat-smooth.mjs` (`npm run test:smooth-chat`) boots the real
bundle in jsdom and asserts it: the composer element survives background
renders, the draft and focus survive an incoming message, sending keeps the
composer alive, and a real navigation still rebuilds. 25/25 checks pass.

## 2. Stickers (`public/stickers.js`, new)

WhatsApp-style, saved **on the account**:

* sticker button in the chat composer opens the tray;
* four built-in packs (Whale Moods, Whale Love, Reactions, Big Day);
* tap to send, long-press (or the message menu) to **save to My stickers**;
* **My stickers** is `user.stickers` — it syncs with the account, so it follows
  the user to every device;
* **Recent** keeps the last stickers used;
* **Make a sticker from a photo** (compressed to 512 px, stored as media);
* sticker messages are ordinary messages with `type: "sticker"`, so they ride
  the existing instant/offline outbox and delivery ticks (`chat-instant.js` now
  carries the `sticker` field through the outbox).

## 3. Users can delete their status posts

`Status → Your updates` now lists every active status with views, time left and
a one-tap **Delete** button (plus **View mine**). Deleting from the story viewer
still works and both paths remove the post for everyone immediately.

## 4. Admin → Servers & API (new admin space)

A dedicated page (`#/admin/connections`, sidebar entry **Servers & API**) where
the admin connects, by hand:

**App servers** — paste the URL, press *Connect server*. It is probed on
`/api/health` before it is accepted, stored with latency / build / rev, and can
be re-tested, made primary or removed. The public app URL is stored here too.

**Email server (Brevo)** — paste the API key and the verified sender, press
*Connect email server*. The key is verified against `GET /v3/account` before it
is stored, the verified senders are listed, and *Send test email* delivers a
real test to the admin's address.

Worker endpoints (implemented in `cloudflare/whalechat-api/src/index.js`):

| route | method | purpose |
|---|---|---|
| `/api/connections` | `GET` | status: servers, email, storage |
| `/api/connections` | `POST` | connect / remove / make primary app server, connect / disconnect Brevo |
| `/api/connections/test` | `POST` | probe app servers, verify Brevo + send a test email |

Storage: D1 `app_state` → key `settings.connections` (never the synced app
database, so a state merge, cache clear or redeploy cannot wipe it). Keys are
never returned — only a mask (`xkeysib••••••cdef`).

Email now uses the key and sender **connected in the panel**; the Worker secret
`BREVO_API_KEY` remains the fallback, so verification codes keep working before
anything is connected. `/api/health` reports `brevoConfigured`, `appServers` and
`publicUrl` from these settings.

`scripts/test-connections.mjs` (`npm run test:connections`) drives the real
`ChatHub` with a fake D1 and network: admin-only access, probe-before-accept,
key-verify-before-store, effective key, durability across a restart, test email
and disconnect. 21/21 checks pass.

## Upgrade notes

* No database migration: `app_state` already exists in `schema.sql`.
* Publish the Worker (`npx wrangler deploy` in `cloudflare/whalechat-api`) and
  the Pages bundle (`bash scripts/build-pages.sh` then
  `npx wrangler pages deploy dist --project-name whalechat --branch main`).
* Nothing to configure for stickers or status; both work on every device.
