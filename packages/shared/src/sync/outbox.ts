import type { StorageAdapter } from '../storage/adapter.js';
import { StorageKeys } from '../storage/keys.js';
import { uuidv4 } from '../utils/id.js';
import { backoffDelay } from '../utils/backoff.js';
import { classifyError } from '../utils/errors.js';

export const OutboxOperationTypes = [
  'message.send',
  'message.read',
  'cart.upsert',
  'cart.remove',
  'order.checkout',
  'trade.place',
  'wallet.transfer',
  'profile.update',
  'admin.action',
] as const;

export type OutboxOperationType = (typeof OutboxOperationTypes)[number];

/** Financial operations are never optimistically "completed" — they are locked. */
export const FINANCIAL_OPERATION_TYPES: ReadonlySet<OutboxOperationType> = new Set([
  'order.checkout',
  'trade.place',
  'wallet.transfer',
  'admin.action',
]);

export type OutboxStatus = 'pending' | 'in_flight' | 'retry' | 'failed' | 'done';

export interface OutboxReservation {
  currency: string;
  amountMinor: number;
  /** wallet key the amount was reserved against */
  walletId: string;
}

export interface OutboxOperation<T = unknown> {
  id: string;
  idempotencyKey: string;
  type: OutboxOperationType;
  payload: T;
  /** optional stable identity so repeated taps cannot enqueue duplicate work */
  dedupeKey: string | null;
  status: OutboxStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: number;
  lastError: string | null;
  reservation: OutboxReservation | null;
}

export interface NewOutboxOperation<T = unknown> {
  type: OutboxOperationType;
  payload: T;
  idempotencyKey?: string;
  dedupeKey?: string | null;
  reservation?: OutboxReservation | null;
}

export interface OutboxQueueOptions {
  storage: StorageAdapter;
  now?: () => number;
  maxAttempts?: number;
  backoff?: { baseMs?: number; maxMs?: number };
}

export type OutboxListener = (ops: OutboxOperation[]) => void;

/**
 * Persistent FIFO mutation queue.
 *
 * - Every row is written to durable storage BEFORE the UI shows success.
 * - idempotencyKey is generated on the client (UUIDv4) and reused on retries.
 * - A dedupeKey collapses repeated identical taps into one queued operation.
 */
export class OutboxQueue {
  private readonly storage: StorageAdapter;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly backoff: { baseMs?: number; maxMs?: number };
  private ops: OutboxOperation[] = [];
  private loaded = false;
  private loading: Promise<void> | null = null;
  private readonly listeners = new Set<OutboxListener>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: OutboxQueueOptions) {
    this.storage = options.storage;
    this.now = options.now ?? Date.now;
    this.maxAttempts = options.maxAttempts ?? 12;
    this.backoff = options.backoff ?? {};
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const stored = await this.storage.get<OutboxOperation[]>(StorageKeys.outbox);
        // An operation left in_flight by a crash is retried, never dropped.
        this.ops = (stored ?? []).map((op) =>
          op.status === 'in_flight' ? { ...op, status: 'retry' as const } : op,
        );
      } catch {
        this.ops = [];
      } finally {
        this.loaded = true;
        this.loading = null;
        this.emit();
      }
    })();
    return this.loading;
  }

  subscribe(listener: OutboxListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  all(): OutboxOperation[] {
    return [...this.ops];
  }

  pending(): OutboxOperation[] {
    return this.ops.filter((op) => op.status === 'pending' || op.status === 'retry');
  }

  failed(): OutboxOperation[] {
    return this.ops.filter((op) => op.status === 'failed');
  }

  size(): number {
    return this.pending().length;
  }

  has(idempotencyKey: string): boolean {
    return this.ops.some((op) => op.idempotencyKey === idempotencyKey);
  }

  async enqueue<T>(input: NewOutboxOperation<T>): Promise<OutboxOperation<T>> {
    await this.load();
    const idempotencyKey = input.idempotencyKey ?? uuidv4();

    const existing = this.ops.find(
      (op) => op.idempotencyKey === idempotencyKey || (input.dedupeKey && op.dedupeKey === input.dedupeKey),
    );
    if (existing) return existing as OutboxOperation<T>;

    const ts = new Date(this.now()).toISOString();
    const op: OutboxOperation<T> = {
      id: uuidv4(),
      idempotencyKey,
      type: input.type,
      payload: input.payload,
      dedupeKey: input.dedupeKey ?? null,
      status: 'pending',
      attempts: 0,
      createdAt: ts,
      updatedAt: ts,
      nextAttemptAt: this.now(),
      lastError: null,
      reservation: input.reservation ?? null,
    };
    this.ops.push(op as OutboxOperation);
    await this.persist();
    return op;
  }

  peek(): OutboxOperation | null {
    return this.pending().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0] ?? null;
  }

  async markInFlight(id: string): Promise<void> {
    this.patch(id, (op) => ({ ...op, status: 'in_flight', updatedAt: new Date(this.now()).toISOString() }));
    await this.persist();
  }

  async markDone(id: string): Promise<void> {
    this.ops = this.ops.filter((op) => op.id !== id);
    await this.persist();
  }

  async markRetry(id: string, error: unknown): Promise<number> {
    const info = classifyError(error);
    let delay = 0;
    this.patch(id, (op) => {
      const attempts = op.attempts + 1;
      const dead = attempts >= this.maxAttempts || info.kind === 'permanent';
      delay = info.retryAfterMs ?? backoffDelay(attempts, this.backoff);
      return {
        ...op,
        attempts,
        status: dead ? 'failed' : 'retry',
        lastError: info.message,
        nextAttemptAt: this.now() + delay,
        updatedAt: new Date(this.now()).toISOString(),
      };
    });
    await this.persist();
    return delay;
  }

  async requeueFailed(): Promise<void> {
    this.ops = this.ops.map((op) =>
      op.status === 'failed'
        ? { ...op, status: 'retry', attempts: 0, nextAttemptAt: this.now(), lastError: null }
        : op,
    );
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    this.ops = this.ops.filter((op) => op.id !== id);
    await this.persist();
  }

  private patch(id: string, fn: (op: OutboxOperation) => OutboxOperation): void {
    this.ops = this.ops.map((op) => (op.id === id ? fn(op) : op));
  }

  private emit(): void {
    const snapshot = this.all();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  /** Serialise writes so two rapid enqueues cannot clobber the queue file. */
  private persist(): Promise<void> {
    const next = this.writeChain.then(async () => {
      await this.storage.set(StorageKeys.outbox, this.ops);
      this.emit();
    });
    this.writeChain = next.catch(() => undefined);
    return next;
  }
}
