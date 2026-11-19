import type { AppwriteClientBundle, AppwriteRealtimeEvent } from './transport.js';
export interface RealtimeBridgeOptions {
    client: AppwriteClientBundle;
    channels: string[];
    onEvent(event: AppwriteRealtimeEvent): void;
    /** fetch missed documents after a drop, using the last updatedAt cursor */
    onResume?(cursor: string | null): Promise<void>;
    cursor?(): string | null;
    onStatus?(status: 'connected' | 'reconnecting' | 'disconnected'): void;
}
/**
 * Appwrite Realtime drops its socket on backgrounding, network changes and
 * token expiry. This wrapper reconnects with exponential backoff and asks the
 * caller to re-fetch deltas from the last `updatedAt` cursor it saw.
 */
export declare function createRealtimeBridge(options: RealtimeBridgeOptions): {
    start(): void;
    stop(): void;
};
//# sourceMappingURL=realtime.d.ts.map