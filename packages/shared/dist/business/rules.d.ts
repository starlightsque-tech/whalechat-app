import type { Order, OrderStatus } from '../types/shop.js';
import type { PlaceTradeInput, Position, Quote, Trade } from '../types/trade.js';
import type { Wallet } from '../types/user.js';
import { type Reservation } from '../sync/financial.js';
/** Legal order transitions — the UI and the backend share this table. */
export declare const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]>;
export declare function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean;
export declare function assertOrderTransition(order: Order, to: OrderStatus): void;
/** Escrow can be released only after delivery + the protection window. */
export declare function canReleaseEscrow(order: Order, now?: number): boolean;
export interface TradeValidation {
    ok: boolean;
    reason?: 'unknown_symbol' | 'invalid_quantity' | 'insufficient_funds' | 'market_closed' | 'no_quote';
    costMinor?: number;
    feesMinor?: number;
}
export declare const TRADE_FEE_RATE = 0.0005;
export declare const MIN_TRADE_FEE_MINOR = 1;
/** Pure trade pre-flight used before the outbox write (double-spend guard). */
export declare function validateTrade(input: PlaceTradeInput, quote: Quote | undefined, wallet: Wallet | null, reservations: Reservation[]): TradeValidation;
export declare function portfolioValueMinor(positions: Position[], cashMinor: number): number;
export declare function escrowHeldMinor(orders: Order[]): number;
export declare function lockedSummary(wallet: Wallet | null, reservations: Reservation[]): Record<string, number>;
export declare function realizedPnl(trades: Trade[]): number;
//# sourceMappingURL=rules.d.ts.map