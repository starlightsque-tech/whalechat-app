import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '../src/storage/adapter.js';
import { createWhalechatStore } from '../src/state/store.js';
import { createDemoBackend } from '../src/demo/backend.js';
import { WhalechatRuntime } from '../src/runtime.js';
import type { NetworkMonitor } from '../src/network/monitor.js';

function fakeNetwork(initial: boolean): NetworkMonitor & { set(online: boolean): void } {
  let online = initial;
  const listeners = new Set<(value: boolean) => void>();
  return {
    isOnline: () => online,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {},
    stop() {},
    async refresh() {
      return online;
    },
    set(value: boolean) {
      online = value;
      for (const listener of listeners) listener(value);
    },
  };
}

describe('offline runtime', () => {
  it('queues a message offline and drains it on reconnect without duplicating', async () => {
    const storage = createMemoryStorage();
    const store = createWhalechatStore();
    const network = fakeNetwork(false);
    const backend = createDemoBackend({ latencyMs: 0, isOnline: () => network.isOnline() });
    const runtime = new WhalechatRuntime().configure({ storage, network, backend, store, now: () => Date.now() });
    await runtime.start();

    const message = await runtime.sendMessage('conv-market', 'hello offline');
    expect(message.status).toBe('sending');
    expect(store.getState().connection.pendingCount).toBe(1);
    expect((store.getState().messages['conv-market'] ?? []).some((m) => m.status === 'sending')).toBe(true);

    network.set(true);
    await runtime.getManager().drain();
    await new Promise((resolve) => setTimeout(resolve, 250));

    const list = store.getState().messages['conv-market'] ?? [];
    expect(list.some((m) => m.body === 'hello offline' && m.status === 'sent')).toBe(true);
    expect(list.filter((m) => m.body === 'hello offline')).toHaveLength(1);
    expect(runtime.getOutbox().size()).toBe(0);
    expect(store.getState().connection.pendingCount).toBe(0);
  });

  it('locks funds on an offline trade and flags it pending_sync', async () => {
    const storage = createMemoryStorage();
    const store = createWhalechatStore();
    const network = fakeNetwork(false);
    const backend = createDemoBackend({ latencyMs: 0, isOnline: () => network.isOnline() });
    const runtime = new WhalechatRuntime().configure({ storage, network, backend, store, now: () => Date.now() });
    await runtime.start();

    // seed cached wallet/quote the way a previous online session would
    store.getState().setWallets([
      {
        id: 'wallet-demo',
        userId: 'demo-user',
        balances: { USD: 1_000_00 },
        locked: {},
        version: 1,
        updatedAt: new Date().toISOString(),
      },
    ]);
    store.getState().setQuotes([
      {
        symbol: 'AAPL',
        price: 200,
        previousClose: 198,
        open: 198,
        high: 201,
        low: 197,
        change: 2,
        changePercent: 1,
        volume: 1,
        currency: 'USD',
        source: 'simulated',
        asOf: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    const trade = await runtime.placeTrade({ symbol: 'AAPL', side: 'buy', quantity: 1, limitPrice: null, currency: 'USD' });
    expect(trade.status).toBe('pending_sync');
    expect(store.getState().reservations[0]?.amountMinor).toBe(20_010);
    expect(store.getState().connection.pendingCount).toBe(1);

    network.set(true);
    await runtime.getManager().drain();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const settled = store.getState().trades[0];
    expect(settled?.status).toBe('filled');
    expect(store.getState().reservations).toHaveLength(0);
  });
});
