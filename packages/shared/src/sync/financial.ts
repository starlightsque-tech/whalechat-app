import type { Wallet } from '../types/user.js';
import type { OutboxReservation } from './outbox.js';

/**
 * Financial safety rules shared by trading, checkout and transfers.
 *
 * Invariant: a user can never spend money that is already committed to an
 * operation that has not been confirmed or rejected by the server.
 */

export interface Reservation extends OutboxReservation {
  ref: string;
  status: 'held' | 'committed' | 'released';
  createdAt: string;
}

export function balanceOf(wallet: Wallet | null | undefined, currency: string): number {
  if (!wallet) return 0;
  return wallet.balances[currency.toUpperCase()] ?? 0;
}

export function reservedOf(reservations: Reservation[], currency: string, walletId?: string): number {
  const code = currency.toUpperCase();
  return reservations
    .filter((r) => r.status === 'held' && r.currency === code && (!walletId || r.walletId === walletId))
    .reduce((sum, r) => sum + r.amountMinor, 0);
}

/** Spendable = server balance − local holds − server-safe locked floor. */
export function availableBalance(
  wallet: Wallet | null | undefined,
  reservations: Reservation[],
  currency: string,
): number {
  const code = currency.toUpperCase();
  const locked = wallet?.locked?.[code] ?? 0;
  return Math.max(0, balanceOf(wallet, code) - reservedOf(reservations, code, wallet?.id) - locked);
}

export type ReserveResult =
  | { ok: true; wallet: Wallet; reservation: Reservation }
  | { ok: false; reason: 'insufficient_funds' | 'invalid_amount' | 'no_wallet'; availableMinor: number };

/**
 * Hold funds locally BEFORE the outbox write. This is what prevents
 * double-spending an offline balance when a trade/checkout is submitted twice.
 */
export function reserveFunds(
  wallet: Wallet | null | undefined,
  reservations: Reservation[],
  input: { currency: string; amountMinor: number; ref: string; now: string },
): ReserveResult {
  if (!wallet) return { ok: false, reason: 'no_wallet', availableMinor: 0 };
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    return { ok: false, reason: 'invalid_amount', availableMinor: availableBalance(wallet, reservations, input.currency) };
  }
  const availableMinor = availableBalance(wallet, reservations, input.currency);
  if (availableMinor < input.amountMinor) {
    return { ok: false, reason: 'insufficient_funds', availableMinor };
  }
  const reservation: Reservation = {
    walletId: wallet.id,
    currency: input.currency.toUpperCase(),
    amountMinor: input.amountMinor,
    ref: input.ref,
    status: 'held',
    createdAt: input.now,
  };
  return { ok: true, wallet, reservation };
}

export function commitReservation(reservations: Reservation[], ref: string): Reservation[] {
  return reservations.map((r) => (r.ref === ref ? { ...r, status: 'committed' } : r));
}

export function releaseReservation(reservations: Reservation[], ref: string): Reservation[] {
  return reservations.map((r) => (r.ref === ref ? { ...r, status: 'released' } : r));
}

/**
 * Server wallet wins. Local held reservations are dropped only after the
 * authoritative snapshot has been applied, so pending operations remain
 * unspendable until the backend confirms or rejects them.
 */
export function reconcileWallet(server: Wallet, reservations: Reservation[]): {
  wallet: Wallet;
  reservations: Reservation[];
} {
  const stillHeld = reservations.filter((r) => {
    if (r.status !== 'held') return false;
    return true;
  });
  return { wallet: server, reservations: stillHeld };
}

/** Balance check used by both the UI and the outbox handler (defence in depth). */
export function canAfford(availableMinor: number, costMinor: number): boolean {
  return Number.isInteger(costMinor) && costMinor > 0 && availableMinor >= costMinor;
}
