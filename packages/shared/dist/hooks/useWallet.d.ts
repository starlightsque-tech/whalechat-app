import type { LedgerTransaction, Portfolio, Wallet } from '../types/index.js';
export interface UseWalletResult {
    wallet: Wallet | null;
    currency: string;
    balanceMinor: number;
    availableMinor: number;
    lockedMinor: number;
    pendingMinor: number;
    ledger: LedgerTransaction[];
    portfolio: Portfolio | null;
    pendingSyncCount: number;
    transfer(toUserId: string, amountMinor: number, note?: string): Promise<void>;
    refresh(): Promise<void>;
}
/** Wallet/portfolio hook backed by cached data + authoritative reconciliation. */
export declare function useWallet(currency?: string): UseWalletResult;
//# sourceMappingURL=useWallet.d.ts.map