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
];
/** Financial operations are never optimistically "completed" — they are locked. */
export const FINANCIAL_OPERATION_TYPES = new Set([
    'order.checkout',
    'trade.place',
    'wallet.transfer',
    'admin.action',
]);
/**
 * Persistent FIFO mutation queue.
 *
 * - Every row is written to durable storage BEFORE the UI shows success.
 * - idempotencyKey is generated on the client (UUIDv4) and reused on retries.
 * - A dedupeKey collapses repeated identical taps into one queued operation.
 */
export class OutboxQueue {
    storage;
    now;
    maxAttempts;
    backoff;
    ops = [];
    loaded = false;
    loading = null;
    listeners = new Set();
    writeChain = Promise.resolve();
    constructor(options) {
        this.storage = options.storage;
        this.now = options.now ?? Date.now;
        this.maxAttempts = options.maxAttempts ?? 12;
        this.backoff = options.backoff ?? {};
    }
    async load() {
        if (this.loaded)
            return;
        if (this.loading)
            return this.loading;
        this.loading = (async () => {
            try {
                const stored = await this.storage.get(StorageKeys.outbox);
                // An operation left in_flight by a crash is retried, never dropped.
                this.ops = (stored ?? []).map((op) => op.status === 'in_flight' ? { ...op, status: 'retry' } : op);
            }
            catch {
                this.ops = [];
            }
            finally {
                this.loaded = true;
                this.loading = null;
                this.emit();
            }
        })();
        return this.loading;
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    all() {
        return [...this.ops];
    }
    pending() {
        return this.ops.filter((op) => op.status === 'pending' || op.status === 'retry');
    }
    failed() {
        return this.ops.filter((op) => op.status === 'failed');
    }
    size() {
        return this.pending().length;
    }
    has(idempotencyKey) {
        return this.ops.some((op) => op.idempotencyKey === idempotencyKey);
    }
    async enqueue(input) {
        await this.load();
        const idempotencyKey = input.idempotencyKey ?? uuidv4();
        const existing = this.ops.find((op) => op.idempotencyKey === idempotencyKey || (input.dedupeKey && op.dedupeKey === input.dedupeKey));
        if (existing)
            return existing;
        const ts = new Date(this.now()).toISOString();
        const op = {
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
        this.ops.push(op);
        await this.persist();
        return op;
    }
    peek() {
        return this.pending().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0] ?? null;
    }
    async markInFlight(id) {
        this.patch(id, (op) => ({ ...op, status: 'in_flight', updatedAt: new Date(this.now()).toISOString() }));
        await this.persist();
    }
    async markDone(id) {
        this.ops = this.ops.filter((op) => op.id !== id);
        await this.persist();
    }
    async markRetry(id, error) {
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
    async requeueFailed() {
        this.ops = this.ops.map((op) => op.status === 'failed'
            ? { ...op, status: 'retry', attempts: 0, nextAttemptAt: this.now(), lastError: null }
            : op);
        await this.persist();
    }
    async remove(id) {
        this.ops = this.ops.filter((op) => op.id !== id);
        await this.persist();
    }
    patch(id, fn) {
        this.ops = this.ops.map((op) => (op.id === id ? fn(op) : op));
    }
    emit() {
        const snapshot = this.all();
        for (const listener of this.listeners) {
            try {
                listener(snapshot);
            }
            catch {
                /* ignore listener errors */
            }
        }
    }
    /** Serialise writes so two rapid enqueues cannot clobber the queue file. */
    persist() {
        const next = this.writeChain.then(async () => {
            await this.storage.set(StorageKeys.outbox, this.ops);
            this.emit();
        });
        this.writeChain = next.catch(() => undefined);
        return next;
    }
}
//# sourceMappingURL=outbox.js.map