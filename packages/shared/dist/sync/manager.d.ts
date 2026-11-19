import type { StorageAdapter } from '../storage/adapter.js';
import type { NetworkMonitor } from '../network/monitor.js';
import type { WhalechatStoreApi } from '../state/store.js';
import type { ConnectionState } from '../types/common.js';
import { OutboxQueue, type OutboxOperation, type OutboxOperationType } from './outbox.js';
export type OutboxHandler = (op: OutboxOperation, context: {
    store: WhalechatStoreApi;
}) => Promise<void>;
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
export declare class SyncManager {
    private readonly options;
    private draining;
    private started;
    private unsubscribeNetwork;
    private unsubscribeOutbox;
    private retryTimer;
    private lastCursor;
    constructor(options: SyncManagerOptions);
    get outbox(): OutboxQueue;
    start(): Promise<void>;
    stop(): void;
    enqueue(op: Parameters<OutboxQueue['enqueue']>[0]): Promise<OutboxOperation>;
    /** Drain in FIFO order until the queue is empty, offline, or blocked. */
    drain(): Promise<void>;
    /** Manual "Retry now" — resets dead-lettered ops and drains immediately. */
    retryNow(): Promise<void>;
    private scheduleRetry;
    private releaseHold;
    private patchConnection;
}
//# sourceMappingURL=manager.d.ts.map