import { useCallback } from 'react';
import { useStore } from 'zustand';
import { whalechatStore } from '../state/store.js';
import { whalechatRuntime } from '../runtime.js';
import { availableBalance } from '../sync/financial.js';
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
export function useWallet(currency = 'USD'): UseWalletResult {
  const wallet = useStore(whalechatStore, (state) => Object.values(state.wallets)[0] ?? null);
  const reservations = useStore(whalechatStore, (state) => state.reservations);
  const ledger = useStore(whalechatStore, (state) => state.ledger);
  const portfolio = useStore(whalechatStore, (state) => state.portfolio);
  const pendingSyncCount = useStore(whalechatStore, (state) => state.connection.pendingCount);

  const code = currency.toUpperCase();
  const balanceMinor = wallet?.balances[code] ?? 0;
  const lockedMinor = wallet?.locked?.[code] ?? 0;
  const availableMinor = availableBalance(wallet, reservations, code);
  const pendingMinor = Math.max(0, balanceMinor - availableMinor);

  const transfer = useCallback(
    async (toUserId: string, amountMinor: number, note?: string) => {
      await whalechatRuntime.transfer(toUserId, code, amountMinor, note);
    },
    [code],
  );

  const refresh = useCallback(async () => {
    await whalechatRuntime.refreshWallet();
  }, []);

  return {
    wallet,
    currency: code,
    balanceMinor,
    availableMinor,
    lockedMinor,
    pendingMinor,
    ledger,
    portfolio,
    pendingSyncCount,
    transfer,
    refresh,
  };
}
