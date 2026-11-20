import { describe, expect, it } from 'vitest';
import { availableBalance, reserveFunds, releaseReservation, type Reservation } from '../src/sync/financial.js';
import type { Wallet } from '../src/types/user.js';

const wallet: Wallet = {
  id: 'w1',
  userId: 'u1',
  balances: { USD: 10_000 },
  locked: {},
  version: 1,
  updatedAt: new Date().toISOString(),
};

describe('financial safety', () => {
  it('prevents double spending across two offline reservations', () => {
    const first = reserveFunds(wallet, [], { currency: 'USD', amountMinor: 6_000, ref: 'a', now: 'x' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const reservations: Reservation[] = [{ ...first.reservation, status: 'held' }];

    const second = reserveFunds(wallet, reservations, { currency: 'USD', amountMinor: 6_000, ref: 'b', now: 'x' });
    expect(second.ok).toBe(false);
    expect(availableBalance(wallet, reservations, 'USD')).toBe(4_000);

    const released = releaseReservation(reservations, 'a');
    expect(availableBalance(wallet, released, 'USD')).toBe(10_000);
  });

  it('honours server-side locked funds', () => {
    const locked: Wallet = { ...wallet, locked: { USD: 2_500 } };
    expect(availableBalance(locked, [], 'USD')).toBe(7_500);
  });
});
