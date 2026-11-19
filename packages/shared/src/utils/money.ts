import type { Money } from '../types/common.js';

/** All amounts are integer minor units (cents) to avoid float drift. */
export function money(amountMinor: number, currency: string): Money {
  return { amountMinor: Math.round(amountMinor), currency: currency.toUpperCase() };
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function formatMoney(m: Money, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: m.currency,
    minimumFractionDigits: 2,
  }).format(m.amountMinor / 100);
}

export function fromDecimal(value: number, currency: string): Money {
  return money(Math.round(value * 100), currency);
}

export function toDecimal(m: Money): number {
  return m.amountMinor / 100;
}

export function assertPositive(m: Money): void {
  if (!Number.isFinite(m.amountMinor) || m.amountMinor <= 0) {
    throw new Error('Amount must be a positive number of minor units');
  }
}
