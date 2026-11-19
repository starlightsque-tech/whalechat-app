import type { WhalechatBackend } from '../backend/types.js';
export interface DemoBackendOptions {
    /** return false to simulate a dropped connection (drives the outbox demo) */
    isOnline?: () => boolean;
    latencyMs?: number;
    now?: () => number;
}
/**
 * Offline-capable demo backend.
 *
 * Implements the same contract as Appwrite, keeps server-side idempotency
 * records, and rejects mutations while `isOnline()` is false so the outbox
 * queue, retries and reconciliation can be exercised end-to-end.
 */
export declare function createDemoBackend(options?: DemoBackendOptions): WhalechatBackend & {
    setOnlineProbe(fn: () => boolean): void;
};
//# sourceMappingURL=backend.d.ts.map