import { WhalechatRuntime, type RuntimeOptions } from '../runtime.js';
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
export declare function useWhalechatSync(options?: RuntimeOptions & {
    runtime?: WhalechatRuntime;
}): UseWhalechatSyncResult;
//# sourceMappingURL=useWhalechatSync.d.ts.map