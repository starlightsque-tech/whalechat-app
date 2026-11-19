import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '../src/storage/adapter.js';
import { OutboxQueue } from '../src/sync/outbox.js';

describe('OutboxQueue', () => {
  it('persists, dedupes and drains in FIFO order', async () => {
    const storage = createMemoryStorage();
    const queue = new OutboxQueue({ storage, now: () => 1_700_000_000_000 });
    await queue.load();

    const first = await queue.enqueue({ type: 'message.send', payload: { body: 'one' } });
    const duplicate = await queue.enqueue({ type: 'message.send', payload: { body: 'one' }, idempotencyKey: first.idempotencyKey });
    expect(duplicate.id).toBe(first.id);

    const cartA = await queue.enqueue({ type: 'cart.upsert', payload: { n: 1 }, dedupeKey: 'cart:a' });
    await queue.enqueue({ type: 'cart.upsert', payload: { n: 2 }, dedupeKey: 'cart:a' });

    expect(queue.size()).toBe(2);
    expect(queue.peek()?.id).toBe(first.id);

    const reloaded = new OutboxQueue({ storage });
    await reloaded.load();
    expect(reloaded.size()).toBe(2);

    await queue.markDone(first.id);
    await queue.markDone(cartA.id);
    expect(queue.size()).toBe(0);
  });

  it('retries with backoff and dead-letters after max attempts', async () => {
    const storage = createMemoryStorage();
    const queue = new OutboxQueue({ storage, maxAttempts: 2, now: () => 1_700_000_000_000 });
    const op = await queue.enqueue({ type: 'trade.place', payload: {} });
    await queue.markInFlight(op.id);
    await queue.markRetry(op.id, new Error('network unavailable'));
    expect(queue.pending()[0]?.status).toBe('retry');
    await queue.markRetry(op.id, new Error('network unavailable'));
    expect(queue.failed()).toHaveLength(1);
    expect(queue.size()).toBe(0);
  });

  it('recovers an in-flight row after a crash', async () => {
    const storage = createMemoryStorage();
    const queue = new OutboxQueue({ storage });
    const op = await queue.enqueue({ type: 'message.send', payload: { body: 'x' } });
    await queue.markInFlight(op.id);
    const recovered = new OutboxQueue({ storage });
    await recovered.load();
    expect(recovered.pending()[0]?.status).toBe('retry');
  });
});
