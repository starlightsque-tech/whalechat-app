/**
 * Cross-platform connectivity monitor.
 *
 * The platform supplies an adapter (navigator.onLine on web, NetInfo on Expo).
 * The monitor debounces flaps, adds a lightweight reachability probe, and
 * exposes a subscribe() contract the sync engine depends on.
 */
export type NetworkListener = (online: boolean) => void;
export interface NetworkAdapter {
    isOnline(): boolean;
    subscribe(listener: NetworkListener): () => void;
    /** Optional HTTP reachability check; defaults to the browser's online flag. */
    probe?(): Promise<boolean>;
}
export interface NetworkMonitor {
    isOnline(): boolean;
    subscribe(listener: NetworkListener): () => void;
    start(): void;
    stop(): void;
    refresh(): Promise<boolean>;
}
export interface NetworkMonitorOptions {
    adapter: NetworkAdapter;
    /** Consecutive probe failures before declaring offline. */
    failureThreshold?: number;
    probeIntervalMs?: number;
    /** Avoid flapping on a single dropped packet. */
    debounceMs?: number;
}
export declare function createNetworkMonitor(options: NetworkMonitorOptions): NetworkMonitor;
/**
 * Web adapter: navigator.onLine + a HEAD request to the API origin.
 * A 4xx still proves reachability, so only network errors count as offline.
 */
export declare function createWebNetworkAdapter(probeUrl?: string): NetworkAdapter;
//# sourceMappingURL=monitor.d.ts.map