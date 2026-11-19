import type { StorageAdapter } from '../storage/adapter.js';
export declare const OutboxOperationTypes: readonly ["message.send", "message.read", "cart.upsert", "cart.remove", "order.checkout", "trade.place", "wallet.transfer", "profile.update", "admin.action"];
export type OutboxOperationType = (typeof OutboxOperationTypes)[number];
/** Financial operations are never optimistically "completed" — they are locked. */
export declare const FINANCIAL_OPERATION_TYPES: ReadonlySet<OutboxOperationType>;
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
    backoff?: {
        baseMs?: number;
        maxMs?: number;
    };
}
export type OutboxListener = (ops: OutboxOperation[]) => void;
/**
 * Persistent FIFO mutation queue.
 *
 * - Every row is written to durable storage BEFORE the UI shows success.
 * - idempotencyKey is generated on the client (UUIDv4) and reused on retries.
 * - A dedupeKey collapses repeated identical taps into one queued operation.
 */
export declare class OutboxQueue {
    private readonly storage;
    private readonly now;
    private readonly maxAttempts;
    private readonly backoff;
    private ops;
    private loaded;
    private loading;
    private readonly listeners;
    private writeChain;
    constructor(options: OutboxQueueOptions);
    load(): Promise<void>;
    subscribe(listener: OutboxListener): () => void;
    all(): OutboxOperation[];
    pending(): OutboxOperation[];
    failed(): OutboxOperation[];
    size(): number;
    has(idempotencyKey: string): boolean;
    enqueue<T>(input: NewOutboxOperation<T>): Promise<OutboxOperation<T>>;
    peek(): OutboxOperation | null;
    markInFlight(id: string): Promise<void>;
    markDone(id: string): Promise<void>;
    markRetry(id: string, error: unknown): Promise<number>;
    requeueFailed(): Promise<void>;
    remove(id: string): Promise<void>;
    private patch;
    private emit;
    /** Serialise writes so two rapid enqueues cannot clobber the queue file. */
    private persist;
}
//# sourceMappingURL=outbox.d.ts.map