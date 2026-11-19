/**
 * One storage contract for every platform.
 *
 * Web  → IndexedDB  (apps/web/src/lib/storage.ts)
 * Expo → MMKV       (apps/mobile/src/lib/storage.ts), SQLite fallback
 *
 * Values must be JSON-serialisable. Implementations are expected to be
 * durable — the offline outbox and wallet snapshots live here.
 */
export interface StorageAdapter {
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T): Promise<void>;
    remove(key: string): Promise<void>;
    keys(prefix?: string): Promise<string[]>;
    clear(prefix?: string): Promise<void>;
    /** Optional atomic batch (IndexedDB transactions / MMKV multiSet). */
    setMany?(entries: Array<[string, unknown]>): Promise<void>;
}
export interface StorageAdapterInfo {
    kind: 'indexeddb' | 'mmkv' | 'sqlite' | 'localstorage' | 'memory';
    durable: boolean;
}
export interface PlatformStorageAdapter extends StorageAdapter {
    readonly info: StorageAdapterInfo;
}
/** Prefix every key so the app never collides with host-page storage. */
export declare function nsKey(key: string): string;
/** In-memory adapter: tests, SSR, and a safe fallback when MMKV is absent. */
export declare function createMemoryStorage(seed?: Record<string, unknown>): PlatformStorageAdapter;
/** Wrap read/write failures so a corrupt cache can never crash app boot. */
export declare function safeGet<T>(storage: StorageAdapter, key: string, fallback: T): Promise<T>;
export declare function safeSet<T>(storage: StorageAdapter, key: string, value: T): Promise<void>;
//# sourceMappingURL=adapter.d.ts.map