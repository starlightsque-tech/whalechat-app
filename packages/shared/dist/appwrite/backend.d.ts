import type { WhalechatBackend } from '../backend/types.js';
import type { AppwriteClientBundle } from './transport.js';
import { type AppwriteConfig } from './transport.js';
export interface AppwriteBackendOptions {
    client: AppwriteClientBundle;
    userId: string;
    config?: Partial<AppwriteConfig> & {
        collections?: Partial<AppwriteConfig['collections']>;
    };
}
/**
 * Appwrite implementation of the shared backend contract.
 *
 * Reads go straight to Databases (fast, realtime-friendly); every mutation
 * goes through the `whalechat-sync` Function so the server can enforce the
 * unique idempotency index and perform atomic wallet/escrow ledger writes.
 */
export declare function createAppwriteBackend(options: AppwriteBackendOptions): WhalechatBackend;
//# sourceMappingURL=backend.d.ts.map