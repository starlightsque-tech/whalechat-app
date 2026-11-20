import { formatMoney, type Money } from '@whalechat/shared';

export function MoneyText({ value, className }: { value: Money | number; className?: string }) {
  const money: Money =
    typeof value === 'number' ? { amountMinor: value, currency: 'USD' } : value;
  return <span className={className}>{formatMoney(money)}</span>;
}

export function formatMinor(amountMinor: number, currency = 'USD'): string {
  return formatMoney({ amountMinor, currency });
}
