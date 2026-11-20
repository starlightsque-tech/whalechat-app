# Appwrite sync API (monorepo)

Implemented in `appwrite-function/monorepo-sync.js` and mounted by
`appwrite-function/index.js` before the legacy routes. Read paths go directly
to Appwrite Databases; all mutations go through these handlers.

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/messages` | Send a message; UUID idempotent, updates conversation preview |
| POST | `/api/messages/read` | Read receipt (`readBy`, status `read`) |
| POST | `/api/orders/checkout` | Server-priced escrow checkout; holds funds |
| POST | `/api/trades` | Buy/sell with server quote, fees and position check |
| POST | `/api/wallet/transfer` | Wallet-to-wallet with a debit/credit ledger pair |
| GET | `/api/admin/overview` | Users/orders/trades/escrow KPIs |
| GET | `/api/admin/users` | User list |
| POST | `/api/admin/users/action` | suspend / reinstate / set_role / adjust_wallet |
| POST | `/api/admin/orders/action` | Order status + escrow release/refund |
| POST | `/api/admin/trades/action` | Trade status |
| GET | `/api/admin/audit` | Audit mirror (legacy state) |

## At-most-once guarantee

Every mutation requires a client UUIDv4 `idempotencyKey` (sent by the shared
outbox). The handler derives the Appwrite document id from that key
(`sha1(key)`), and the collections also carry a **UNIQUE index** on
`idempotencyKey`. A retry therefore either returns the existing document or
receives `409 in_progress`; it can never create a second order/trade/message.
Financial rows are additionally locked by the deterministic ledger document.

## Wallet holds

- Checkout recomputes line items from `products` (client prices are ignored),
  checks `availableMinor`, then moves the total from available to `lockedMinor`
  while the order is `paid_escrow`.
- Trades check available funds (buy) or net filled position (sell) before
  writing and record a ledger row.
- Transfers debit the sender, credit the recipient and write both ledger rows.
- Refunding/cancelling an escrow order in the admin API returns the held amount.
- Failure compensation rolls the wallet back and removes the pending document
  when no ledger row was written.

## Identity & admin

- Identity comes from `x-appwrite-user-id` (Appwrite session header). This is
  required by default — a body-supplied `userId` is ignored unless
  `WC_SYNC_TRUST_BODY_USER=1` is set for a migration/test window. Financial
  endpoints must never be deployed with the body fallback enabled.
- `WC_SYNC_REQUIRE_SESSION=0` is only for local harnesses.
- `GET/POST /api/admin/*` additionally requires the user document (or the
  legacy state mirror) to have `role: admin|superadmin`.

## Schema & permissions

Run the idempotent provisioner:

```bash
APPWRITE_PROJECT_ID=... APPWRITE_API_KEY=... \
  node scripts/provision-monorepo-appwrite.mjs
```

It creates 8 collections with per-document security: `users` readable by the
`users` role, `products` public, and wallets/orders/trades/ledger/messages
readable only by the owning user (`read("user:<id>")` set by the function).

## Deploy the new web build

```bash
APPWRITE_PROJECT_ID=... APPWRITE_API_KEY=... \
WC_DEPLOY_DOMAIN=whalechat.appwrite.network \
  node scripts/deploy-monorepo-site.mjs
```

The script builds `apps/web` (hosted bundle), publishes both `index.html` and
`whalechat.html` (the APK entry), activates the deployment, optionally binds
the domain, and verifies `https://<domain>/whalechat.html` returns 200 with the
Whalechat shell.

## Tests

`node --test appwrite-function/test/monorepo-sync.test.mjs` (7 tests) covers
message replay, checkout holds/replay, concurrent checkout double-spend,
server-priced trades, transfer replay, admin authorization and identity
mismatch. CI runs this alongside the shared package tests.
