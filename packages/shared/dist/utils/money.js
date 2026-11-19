/** All amounts are integer minor units (cents) to avoid float drift. */
export function money(amountMinor, currency) {
    return { amountMinor: Math.round(amountMinor), currency: currency.toUpperCase() };
}
export function addMoney(a, b) {
    assertSameCurrency(a, b);
    return money(a.amountMinor + b.amountMinor, a.currency);
}
export function subMoney(a, b) {
    assertSameCurrency(a, b);
    return money(a.amountMinor - b.amountMinor, a.currency);
}
export function assertSameCurrency(a, b) {
    if (a.currency !== b.currency) {
        throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
    }
}
export function formatMoney(m, locale = 'en-US') {
    return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: m.currency,
        minimumFractionDigits: 2,
    }).format(m.amountMinor / 100);
}
export function fromDecimal(value, currency) {
    return money(Math.round(value * 100), currency);
}
export function toDecimal(m) {
    return m.amountMinor / 100;
}
export function assertPositive(m) {
    if (!Number.isFinite(m.amountMinor) || m.amountMinor <= 0) {
        throw new Error('Amount must be a positive number of minor units');
    }
}
//# sourceMappingURL=money.js.map