export function balanceOf(wallet, currency) {
    if (!wallet)
        return 0;
    return wallet.balances[currency.toUpperCase()] ?? 0;
}
export function reservedOf(reservations, currency, walletId) {
    const code = currency.toUpperCase();
    return reservations
        .filter((r) => r.status === 'held' && r.currency === code && (!walletId || r.walletId === walletId))
        .reduce((sum, r) => sum + r.amountMinor, 0);
}
/** Spendable = server balance − local holds − server-safe locked floor. */
export function availableBalance(wallet, reservations, currency) {
    const code = currency.toUpperCase();
    const locked = wallet?.locked?.[code] ?? 0;
    return Math.max(0, balanceOf(wallet, code) - reservedOf(reservations, code, wallet?.id) - locked);
}
/**
 * Hold funds locally BEFORE the outbox write. This is what prevents
 * double-spending an offline balance when a trade/checkout is submitted twice.
 */
export function reserveFunds(wallet, reservations, input) {
    if (!wallet)
        return { ok: false, reason: 'no_wallet', availableMinor: 0 };
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
        return { ok: false, reason: 'invalid_amount', availableMinor: availableBalance(wallet, reservations, input.currency) };
    }
    const availableMinor = availableBalance(wallet, reservations, input.currency);
    if (availableMinor < input.amountMinor) {
        return { ok: false, reason: 'insufficient_funds', availableMinor };
    }
    const reservation = {
        walletId: wallet.id,
        currency: input.currency.toUpperCase(),
        amountMinor: input.amountMinor,
        ref: input.ref,
        status: 'held',
        createdAt: input.now,
    };
    return { ok: true, wallet, reservation };
}
export function commitReservation(reservations, ref) {
    return reservations.map((r) => (r.ref === ref ? { ...r, status: 'committed' } : r));
}
export function releaseReservation(reservations, ref) {
    return reservations.map((r) => (r.ref === ref ? { ...r, status: 'released' } : r));
}
/**
 * Server wallet wins. Local held reservations are dropped only after the
 * authoritative snapshot has been applied, so pending operations remain
 * unspendable until the backend confirms or rejects them.
 */
export function reconcileWallet(server, reservations) {
    const stillHeld = reservations.filter((r) => {
        if (r.status !== 'held')
            return false;
        return true;
    });
    return { wallet: server, reservations: stillHeld };
}
/** Balance check used by both the UI and the outbox handler (defence in depth). */
export function canAfford(availableMinor, costMinor) {
    return Number.isInteger(costMinor) && costMinor > 0 && availableMinor >= costMinor;
}
//# sourceMappingURL=financial.js.map