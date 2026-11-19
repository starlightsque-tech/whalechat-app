# Offline-first & zero-error sync

## Invariants

1. **Cache first, always.** `hydrateStore()` reads profile, wallet, chats,
   products, assets, quotes, candles, portfolio, trades, orders and ledger from
   the storage adapter before any network call. A cold start offline still
   renders every screen.
2. **No raw writes from UI.** `whalechatRuntime` is the only mutation entry
   point. It (a) updates the Zustand store optimistically, (b) writes a durable
   outbox row, then (c) lets `SyncManager` perform the network call.
3. **Client-owned idempotency.** Every outbox row gets a UUIDv4
   `idempotencyKey` at creation and reuses it on every retry. The backend has a
   UNIQUE index on that column, so duplicate delivery is physically impossible
   for messages, orders, trades and ledger rows.
4. **Financial double-spend guard.** Trades, checkouts and transfers call
   `reserveFunds()` first. A hold (`Reservation`, `status: 'held'`) reduces the
   locally available balance immediately. A second offline trade cannot spend
   the same funds. Holds are released on dead-letter, and dropped only after an
   authoritative wallet snapshot is applied (`reconcileWallet`).
5. **FIFO head-of-line blocking.** `SyncManager.drain()` always takes the oldest
   pending row. A blocked financial operation stops later rows from overtaking
   it, preserving causal order.
6. **Backoff + dead letter.** Retries use exponential backoff with jitter
   (`utils/backoff.ts`), capped at 5 minutes. Permanent errors and rows past
   `maxAttempts` move to `failed`; the banner exposes “Retry failed” which
   re-queues them (`retryNow`).
7. **Crash safety.** A row left `in_flight` by a crash is rehydrated as `retry`
   on the next `OutboxQueue.load()`.
8. **Realtime recovery.** `createRealtimeBridge()` reconnects with backoff and
   calls `onResume(cursor)` using the last `updatedAt` cursor so missed
   documents are re-fetched. The Appwrite backend also falls back to 10 s quote
   polling when Realtime is unavailable.

## Mutation lifecycle

```
user action
  → store optimistic update (message: sending, trade: pending_sync, order: pending_sync)
  → outbox.enqueue({ idempotencyKey })
  → network online? drain()
      → handler → backend (function execution with idempotencyKey)
      → success: replace optimistic row, refresh wallet, release hold
      → failure: markRetry (exponential backoff) / failed (release hold, flag UI)
  → offline? banner shows queued count; UI remains fully interactive
```

## Message status

`sending → sent → delivered → read` (+ `failed`). Optimistic messages carry
`clientId`; when the server row returns it replaces the local row without
duplicating, because the outbox handler maps by `optimisticId`/`clientId`.

## Wallet display

`useWallet()` returns:

- `balanceMinor` — cached/server wallet total
- `lockedMinor` — server-side held funds
- `pendingMinor` — `balance − available` (local holds)
- `availableMinor` — spendable now

The UI never lets a user spend `availableMinor` twice.

## Tests

`packages/shared/test/` (run `pnpm mono:test`):

- outbox persistence, dedupe, FIFO, retry/dead-letter, crash recovery
- offline double-spend prevention and server-locked funds
- end-to-end offline message drain without duplication
- offline trade with funds locked, then filled and reconciled on reconnect
