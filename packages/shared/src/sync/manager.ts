import type { StorageAdapter } from '../storage/adapter.js';
import type { NetworkMonitor } from '../network/monitor.js';
import type { WhalechatStoreApi } from '../state/store.js';
import type { ConnectionState } from '../types/common.js';
import { classifyError } from '../utils/errors.js';
import { nowIso } from '../utils/time.js';
import { OutboxQueue, type OutboxOperation, type OutboxOperationType } from './outbox.js';
import { releaseReservation, type Reservation } from './financial.js';

export type OutboxHandler = (op: OutboxOperation, context: { store: WhalechatStoreApi }) => Promise<void>;

export interface SyncManagerOptions {
  storage: StorageAdapter;
  network: NetworkMonitor;
  outbox: OutboxQueue;
  store: WhalechatStoreApi;
  handlers: Partial<Record<OutboxOperationType, OutboxHandler>>;
  now?: () => number;
  onStatus?(connection: ConnectionState): void;
  /** called when an operation exhausts retries — release holds here */
  onDeadLetter?(op: OutboxOperation): void | Promise<void>;
  /** refresh authoritative caches after a successful drain */
  reconcile?(): Promise<void>;
}

/**
 * FIFO outbox drain with exponential backoff and a connectivity gate.
 *
 * Head-of-line blocking is deliberate: a financial operation that cannot
 * reach the server must not be overtaken by a later mutation that depends
 * on its result (e.g. checkout before trade settlement).
 */
export class SyncManager {
  private readonly options: SyncManagerOptions;
  private draining = false;
  private started = false;
  private unsubscribeNetwork: (() => void) | null = null;
  private unsubscribeOutbox: (() => void) | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCursor: string | null = null;

  constructor(options: SyncManagerOptions) {
    this.options = options;
  }

  get outbox(): OutboxQueue {
    return this.options.outbox;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.options.outbox.load();

    this.unsubscribeOutbox = this.options.outbox.subscribe((ops) => {
      const pending = ops.filter((op) => op.status === 'pending' || op.status === 'retry');
      const failed = ops.filter((op) => op.status === 'failed');
      this.patchConnection({ pendingCount: pending.length, failedCount: failed.length });
    });

    this.unsubscribeNetwork = this.options.network.subscribe((online) => {
      if (online) {
        this.patchConnection({ online: true, status: 'syncing' });
        void this.drain();
      } else {
        this.patchConnection({ online: false, status: 'offline' });
      }
    });

    this.patchConnection({
      online: this.options.network.isOnline(),
      pendingCount: this.options.outbox.size(),
      failedCount: this.options.outbox.failed().length,
      status: this.options.network.isOnline() ? 'syncing' : 'offline',
    });

    if (this.options.network.isOnline()) await this.drain();
    else this.patchConnection({ status: 'offline' });
  }

  stop(): void {
    this.started = false;
    this.unsubscribeNetwork?.();
    this.unsubscribeOutbox?.();
    this.unsubscribeNetwork = null;
    this.unsubscribeOutbox = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  async enqueue(op: Parameters<OutboxQueue['enqueue']>[0]): Promise<OutboxOperation> {
    const queued = await this.options.outbox.enqueue(op);
    this.patchConnection({ pendingCount: this.options.outbox.size() });
    if (this.options.network.isOnline()) void this.drain();
    return queued;
  }

  /** Drain in FIFO order until the queue is empty, offline, or blocked. */
  async drain(): Promise<void> {
    if (this.draining || !this.started) return;
    if (!this.options.network.isOnline()) {
      this.patchConnection({ status: 'offline', online: false });
      return;
    }
    this.draining = true;
    this.patchConnection({ status: 'syncing' });
    const store = this.options.store;

    try {
      for (;;) {
        if (!this.options.network.isOnline()) {
          this.patchConnection({ status: 'offline', online: false });
          break;
        }
        const op = this.options.outbox.peek();
        if (!op) break;
        if (op.nextAttemptAt > (this.options.now ?? Date.now)()) {
          this.scheduleRetry(op.nextAttemptAt - (this.options.now ?? Date.now)());
          break;
        }

        const handler = this.options.handlers[op.type];
        if (!handler) {
          await this.options.outbox.markRetry(op.id, new Error(`No handler for ${op.type}`));
          break;
        }

        await this.options.outbox.markInFlight(op.id);
        try {
          await handler(op, { store });
          await this.options.outbox.markDone(op.id);
          this.lastCursor = nowIso(this.options.now);
          await this.options.storage.set('sync:realtime:cursor', this.lastCursor);
        } catch (error) {
          const delay = await this.options.outbox.markRetry(op.id, error);
          const info = classifyError(error);
          const updated = this.options.outbox.all().find((candidate) => candidate.id === op.id);
          if (updated?.status === 'failed' || info.kind === 'permanent') {
            await this.releaseHold(op);
            await this.options.onDeadLetter?.(op);
            this.patchConnection({ lastError: info.message, failedCount: this.options.outbox.failed().length });
            continue;
          }
          this.patchConnection({ lastError: info.message, status: this.options.network.isOnline() ? 'syncing' : 'offline' });
          this.scheduleRetry(delay);
          break;
        }
      }

      if (this.options.outbox.size() === 0) {
        this.patchConnection({
          status: this.options.network.isOnline() ? 'online' : 'offline',
          pendingCount: 0,
          failedCount: this.options.outbox.failed().length,
          lastSyncedAt: nowIso(this.options.now),
          lastError: null,
        });
        await this.options.reconcile?.();
      } else {
        this.patchConnection({
          pendingCount: this.options.outbox.size(),
          status: this.options.network.isOnline() ? 'syncing' : 'offline',
        });
      }
    } finally {
      this.draining = false;
    }
  }

  /** Manual "Retry now" — resets dead-lettered ops and drains immediately. */
  async retryNow(): Promise<void> {
    await this.options.outbox.requeueFailed();
    await this.drain();
  }

  private scheduleRetry(delayMs: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const bounded = Math.max(500, Math.min(delayMs, 5 * 60_000));
    this.retryTimer = setTimeout(() => {
      if (this.options.network.isOnline()) void this.drain();
    }, bounded);
  }

  private async releaseHold(op: OutboxOperation): Promise<void> {
    if (!op.reservation) return;
    const state = this.options.store.getState();
    this.options.store.getState().setReservations(releaseReservation(state.reservations, op.idempotencyKey));
    const reservations: Reservation[] = this.options.store.getState().reservations;
    await this.options.storage.set('sync:outbox:reservations', reservations).catch(() => undefined);
  }

  private patchConnection(patch: Partial<ConnectionState>): void {
    const store = this.options.store;
    store.getState().setConnection(patch);
    this.options.onStatus?.(store.getState().connection);
  }
}
