import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { whalechatStore, type WhalechatState } from '../state/store.js';
import { WhalechatRuntime, whalechatRuntime, type RuntimeOptions } from '../runtime.js';
import type { ConnectionState } from '../types/common.js';

export interface UseWhalechatSyncResult {
  connection: ConnectionState;
  booted: boolean;
  online: boolean;
  syncing: boolean;
  retryNow(): Promise<void>;
  refresh(): Promise<void>;
}

/**
 * Boots the shared runtime once and exposes a reactive sync/connection state.
 * Mount it at the app root (web `<App>` / Expo `app/_layout.tsx`).
 */
export function useWhalechatSync(options?: RuntimeOptions & { runtime?: WhalechatRuntime }): UseWhalechatSyncResult {
  const runtimeRef = useRef<WhalechatRuntime | null>(options?.runtime ?? null);
  const [bootError, setBootError] = useState<string | null>(null);

  if (!runtimeRef.current) {
    runtimeRef.current = options ? whalechatRuntime.configure(options) : whalechatRuntime;
  }

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    let cancelled = false;
    void runtime.start().catch((error) => {
      if (!cancelled) setBootError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const connection = useStore(whalechatStore, (state: WhalechatState) => state.connection);
  const booted = useStore(whalechatStore, (state) => state.booted);

  const retryNow = useCallback(async () => {
    await runtimeRef.current?.retryNow();
  }, []);

  const refresh = useCallback(async () => {
    await runtimeRef.current?.refreshAll();
  }, []);

  return {
    connection: bootError ? { ...connection, status: 'error', lastError: bootError } : connection,
    booted,
    online: connection.online,
    syncing: connection.status === 'syncing' || connection.status === 'connecting',
    retryNow,
    refresh,
  };
}
