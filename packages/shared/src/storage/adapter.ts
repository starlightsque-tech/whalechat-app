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

const NAMESPACE = 'whalechat';

/** Prefix every key so the app never collides with host-page storage. */
export function nsKey(key: string): string {
  return `${NAMESPACE}:${key}`;
}

/** In-memory adapter: tests, SSR, and a safe fallback when MMKV is absent. */
export function createMemoryStorage(seed: Record<string, unknown> = {}): PlatformStorageAdapter {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(seed)) map.set(nsKey(k), JSON.stringify(v));
  return {
    info: { kind: 'memory', durable: false },
    async get<T>(key: string): Promise<T | null> {
      const raw = map.get(nsKey(key));
      return raw === undefined ? null : (JSON.parse(raw) as T);
    },
    async set<T>(key: string, value: T): Promise<void> {
      map.set(nsKey(key), JSON.stringify(value));
    },
    async remove(key: string): Promise<void> {
      map.delete(nsKey(key));
    },
    async keys(prefix = ''): Promise<string[]> {
      const full = nsKey(prefix);
      return [...map.keys()].filter((k) => k.startsWith(full)).map((k) => k.slice(NAMESPACE.length + 1));
    },
    async clear(prefix = ''): Promise<void> {
      const full = nsKey(prefix);
      for (const k of [...map.keys()]) if (k.startsWith(full)) map.delete(k);
    },
    async setMany(entries): Promise<void> {
      for (const [k, v] of entries) map.set(nsKey(k), JSON.stringify(v));
    },
  };
}

/** Wrap read/write failures so a corrupt cache can never crash app boot. */
export async function safeGet<T>(storage: StorageAdapter, key: string, fallback: T): Promise<T> {
  try {
    const value = await storage.get<T>(key);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

export async function safeSet<T>(storage: StorageAdapter, key: string, value: T): Promise<void> {
  try {
    await storage.set(key, value);
  } catch {
    // Cache writes are best-effort; the outbox write is the source of truth
    // for pending mutations and is retried by the sync manager.
  }
}
