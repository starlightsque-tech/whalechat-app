import type { Order, OrderStatus } from '../types/shop.js';
import type { PlaceTradeInput, Position, Quote, Trade } from '../types/trade.js';
import type { Wallet } from '../types/user.js';
import { availableBalance, reservedOf, type Reservation } from '../sync/financial.js';

/** Legal order transitions — the UI and the backend share this table. */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  draft: ['pending_sync', 'cancelled'],
  pending_sync: ['awaiting_payment', 'failed', 'cancelled'],
  awaiting_payment: ['paid_escrow', 'cancelled', 'failed'],
  paid_escrow: ['processing', 'refunded', 'cancelled'],
  processing: ['shipped', 'refunded', 'cancelled'],
  shipped: ['delivered', 'refunded'],
  delivered: ['completed', 'refunded'],
  completed: ['refunded'],
  cancelled: [],
  refunded: [],
  failed: [],
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function assertOrderTransition(order: Order, to: OrderStatus): void {
  if (!canTransitionOrder(order.status, to)) {
    throw new Error(`Illegal order transition ${order.status} → ${to}`);
  }
}

/** Escrow can be released only after delivery + the protection window. */
export function canReleaseEscrow(order: Order, now = Date.now()): boolean {
  if (!order.escrow.held) return false;
  if (order.status !== 'delivered' && order.status !== 'completed') return false;
  if (!order.escrow.releaseAfter) return true;
  return Date.parse(order.escrow.releaseAfter) <= now;
}

export interface TradeValidation {
  ok: boolean;
  reason?: 'unknown_symbol' | 'invalid_quantity' | 'insufficient_funds' | 'market_closed' | 'no_quote';
  costMinor?: number;
  feesMinor?: number;
}

export const TRADE_FEE_RATE = 0.0005;
export const MIN_TRADE_FEE_MINOR = 1;

/** Pure trade pre-flight used before the outbox write (double-spend guard). */
export function validateTrade(
  input: PlaceTradeInput,
  quote: Quote | undefined,
  wallet: Wallet | null,
  reservations: Reservation[],
): TradeValidation {
  if (!quote) return { ok: false, reason: 'no_quote' };
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) return { ok: false, reason: 'invalid_quantity' };
  const price = input.limitPrice ?? quote.price;
  const costMinor = Math.round(input.quantity * price * 100);
  const feesMinor = Math.max(MIN_TRADE_FEE_MINOR, Math.round(costMinor * TRADE_FEE_RATE));
  if (input.side === 'sell') return { ok: true, costMinor, feesMinor };
  const available = availableBalance(wallet, reservations, input.currency);
  if (available < costMinor + feesMinor) return { ok: false, reason: 'insufficient_funds', costMinor, feesMinor };
  return { ok: true, costMinor, feesMinor };
}

export function portfolioValueMinor(positions: Position[], cashMinor: number): number {
  return cashMinor + positions.reduce((sum, position) => sum + position.marketValueMinor, 0);
}

export function escrowHeldMinor(orders: Order[]): number {
  return orders
    .filter((order) => order.escrow.held)
    .reduce((sum, order) => sum + order.total.amountMinor, 0);
}

export function lockedSummary(wallet: Wallet | null, reservations: Reservation[]): Record<string, number> {
  const currencies = new Set([
    ...Object.keys(wallet?.balances ?? {}),
    ...reservations.map((r) => r.currency),
  ]);
  const result: Record<string, number> = {};
  for (const currency of currencies) result[currency] = reservedOf(reservations, currency);
  return result;
}

export function realizedPnl(trades: Trade[]): number {
  return trades.reduce((sum, trade) => {
    if (trade.status !== 'filled' || !trade.filledPrice) return sum;
    return sum + (trade.side === 'sell' ? trade.notional.amountMinor : -trade.notional.amountMinor);
  }, 0);
}
