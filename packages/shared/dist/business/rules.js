import { availableBalance, reservedOf } from '../sync/financial.js';
/** Legal order transitions — the UI and the backend share this table. */
export const ORDER_TRANSITIONS = {
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
export function canTransitionOrder(from, to) {
    return ORDER_TRANSITIONS[from].includes(to);
}
export function assertOrderTransition(order, to) {
    if (!canTransitionOrder(order.status, to)) {
        throw new Error(`Illegal order transition ${order.status} → ${to}`);
    }
}
/** Escrow can be released only after delivery + the protection window. */
export function canReleaseEscrow(order, now = Date.now()) {
    if (!order.escrow.held)
        return false;
    if (order.status !== 'delivered' && order.status !== 'completed')
        return false;
    if (!order.escrow.releaseAfter)
        return true;
    return Date.parse(order.escrow.releaseAfter) <= now;
}
export const TRADE_FEE_RATE = 0.0005;
export const MIN_TRADE_FEE_MINOR = 1;
/** Pure trade pre-flight used before the outbox write (double-spend guard). */
export function validateTrade(input, quote, wallet, reservations) {
    if (!quote)
        return { ok: false, reason: 'no_quote' };
    if (!Number.isFinite(input.quantity) || input.quantity <= 0)
        return { ok: false, reason: 'invalid_quantity' };
    const price = input.limitPrice ?? quote.price;
    const costMinor = Math.round(input.quantity * price * 100);
    const feesMinor = Math.max(MIN_TRADE_FEE_MINOR, Math.round(costMinor * TRADE_FEE_RATE));
    if (input.side === 'sell')
        return { ok: true, costMinor, feesMinor };
    const available = availableBalance(wallet, reservations, input.currency);
    if (available < costMinor + feesMinor)
        return { ok: false, reason: 'insufficient_funds', costMinor, feesMinor };
    return { ok: true, costMinor, feesMinor };
}
export function portfolioValueMinor(positions, cashMinor) {
    return cashMinor + positions.reduce((sum, position) => sum + position.marketValueMinor, 0);
}
export function escrowHeldMinor(orders) {
    return orders
        .filter((order) => order.escrow.held)
        .reduce((sum, order) => sum + order.total.amountMinor, 0);
}
export function lockedSummary(wallet, reservations) {
    const currencies = new Set([
        ...Object.keys(wallet?.balances ?? {}),
        ...reservations.map((r) => r.currency),
    ]);
    const result = {};
    for (const currency of currencies)
        result[currency] = reservedOf(reservations, currency);
    return result;
}
export function realizedPnl(trades) {
    return trades.reduce((sum, trade) => {
        if (trade.status !== 'filled' || !trade.filledPrice)
            return sum;
        return sum + (trade.side === 'sell' ? trade.notional.amountMinor : -trade.notional.amountMinor);
    }, 0);
}
//# sourceMappingURL=rules.js.map