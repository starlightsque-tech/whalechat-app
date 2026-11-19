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
export declare function balanceOf(wallet: Wallet | null | undefined, currency: string): number;
export declare function reservedOf(reservations: Reservation[], currency: string, walletId?: string): number;
/** Spendable = server balance − local holds − server-safe locked floor. */
export declare function availableBalance(wallet: Wallet | null | undefined, reservations: Reservation[], currency: string): number;
export type ReserveResult = {
    ok: true;
    wallet: Wallet;
    reservation: Reservation;
} | {
    ok: false;
    reason: 'insufficient_funds' | 'invalid_amount' | 'no_wallet';
    availableMinor: number;
};
/**
 * Hold funds locally BEFORE the outbox write. This is what prevents
 * double-spending an offline balance when a trade/checkout is submitted twice.
 */
export declare function reserveFunds(wallet: Wallet | null | undefined, reservations: Reservation[], input: {
    currency: string;
    amountMinor: number;
    ref: string;
    now: string;
}): ReserveResult;
export declare function commitReservation(reservations: Reservation[], ref: string): Reservation[];
export declare function releaseReservation(reservations: Reservation[], ref: string): Reservation[];
/**
 * Server wallet wins. Local held reservations are dropped only after the
 * authoritative snapshot has been applied, so pending operations remain
 * unspendable until the backend confirms or rejects them.
 */
export declare function reconcileWallet(server: Wallet, reservations: Reservation[]): {
    wallet: Wallet;
    reservations: Reservation[];
};
/** Balance check used by both the UI and the outbox handler (defence in depth). */
export declare function canAfford(availableMinor: number, costMinor: number): boolean;
//# sourceMappingURL=financial.d.ts.map