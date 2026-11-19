import type { Money } from '../types/common.js';
/** All amounts are integer minor units (cents) to avoid float drift. */
export declare function money(amountMinor: number, currency: string): Money;
export declare function addMoney(a: Money, b: Money): Money;
export declare function subMoney(a: Money, b: Money): Money;
export declare function assertSameCurrency(a: Money, b: Money): void;
export declare function formatMoney(m: Money, locale?: string): string;
export declare function fromDecimal(value: number, currency: string): Money;
export declare function toDecimal(m: Money): number;
export declare function assertPositive(m: Money): void;
//# sourceMappingURL=money.d.ts.map