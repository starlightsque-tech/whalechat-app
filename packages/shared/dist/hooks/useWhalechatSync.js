import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { whalechatStore } from '../state/store.js';
import { whalechatRuntime } from '../runtime.js';
/**
 * Boots the shared runtime once and exposes a reactive sync/connection state.
 * Mount it at the app root (web `<App>` / Expo `app/_layout.tsx`).
 */
export function useWhalechatSync(options) {
    const runtimeRef = useRef(options?.runtime ?? null);
    const [bootError, setBootError] = useState(null);
    if (!runtimeRef.current) {
        runtimeRef.current = options ? whalechatRuntime.configure(options) : whalechatRuntime;
    }
    useEffect(() => {
        const runtime = runtimeRef.current;
        if (!runtime)
            return;
        let cancelled = false;
        void runtime.start().catch((error) => {
            if (!cancelled)
                setBootError(error instanceof Error ? error.message : String(error));
        });
        return () => {
            cancelled = true;
        };
    }, []);
    const connection = useStore(whalechatStore, (state) => state.connection);
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
//# sourceMappingURL=useWhalechatSync.js.map